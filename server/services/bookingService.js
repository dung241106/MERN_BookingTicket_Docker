import Stripe from "stripe";
import Show from "../models/Show.js";
import Booking from "../models/Booking.js";
import { inngest } from "../inngest/client.js";

const error = (status, message) => Object.assign(new Error(message), { status });
export const HOLD_MS = 10 * 60 * 1000;

// Injection is used by regression tests; the application uses the real integrations.
export function createBookingService({
  shows = Show,
  bookings = Booking,
  stripeFactory = () => new Stripe(process.env.STRIPE_SECRET_KEY, { timeout: 15000, maxNetworkRetries: 1 }),
  sendEvent = (event) => inngest.send(event),
} = {}) {
  const sessionParams = (booking) => ({
    success_url: `${booking.checkoutOrigin}/loading/my-bookings`,
    cancel_url: `${booking.checkoutOrigin}/my-bookings`,
    line_items: [{ price_data: {
      currency: "usd", product_data: { name: booking.checkoutTitle },
      unit_amount: Math.round(booking.amount * 100),
    }, quantity: 1 }],
    mode: "payment",
    metadata: { bookingId: booking._id.toString() },
    expires_at: Math.floor(new Date(booking.checkoutExpiresAt).getTime() / 1000),
  });

  async function recoverSession(booking, stripe) {
    if (booking.stripeSessionId) return stripe.checkout.sessions.retrieve(booking.stripeSessionId);
    // Existing bookings stored the Checkout URL but not its session ID.
    if (booking.paymentLink) {
      const url = new URL(booking.paymentLink);
      const id = url.hostname === "checkout.stripe.com" && /cs_(?:test|live)_[a-z\d]+/i.exec(url.pathname)?.[0];
      if (!id) throw new Error(`Legacy booking ${booking._id} needs manual Stripe reconciliation`);
      await bookings.updateOne({ _id: booking._id }, { $set: { stripeSessionId: id } });
      return stripe.checkout.sessions.retrieve(id);
    }
    // Repeat an interrupted create with exactly the same parameters and idempotency key.
    if (booking.checkoutAttempted && booking.checkoutOrigin && booking.checkoutExpiresAt) {
      if (Date.now() - new Date(booking.createdAt).getTime() > 23 * 60 * 60 * 1000) {
        throw new Error(`Booking ${booking._id} needs Stripe reconciliation before seats can be released`);
      }
      const session = await stripe.checkout.sessions.create(sessionParams(booking), { idempotencyKey: `booking-${booking._id}` });
      await bookings.updateOne({ _id: booking._id }, { $set: { stripeSessionId: session.id } });
      return session;
    }
    return null;
  }

  async function releaseSeats(booking) {
    // A retry must never remove a seat held by a newer booking, even for the same user.
    for (const seat of booking.bookedSeats) {
      await shows.updateOne({ _id: booking.show, [`seatBookings.${seat}`]: booking._id.toString() }, {
        $unset: { [`occupiedSeats.${seat}`]: "", [`seatBookings.${seat}`]: "" },
      });
      // Older documents have no ownership map. Release only an unambiguous legacy hold.
      if (!await bookings.exists({ _id: { $ne: booking._id }, show: booking.show, bookedSeats: seat })) {
        await shows.updateOne({ _id: booking.show, [`occupiedSeats.${seat}`]: booking.user, [`seatBookings.${seat}`]: { $exists: false } }, {
          $unset: { [`occupiedSeats.${seat}`]: "" },
        });
      }
    }
    await bookings.deleteOne({ _id: booking._id, isPaid: false });
  }

  async function confirm(session) {
    const booking = await bookings.findById(session.metadata?.bookingId);
    if (!booking) return false;
    if (session.payment_status !== "paid") return false;
    if (session.currency !== "usd" || session.amount_total !== Math.round(booking.amount * 100) ||
        (booking.stripeSessionId && booking.stripeSessionId !== session.id)) {
      throw new Error("Stripe session does not match the booking");
    }
    await bookings.updateOne({ _id: booking._id }, { $set: { isPaid: true, paymentLink: "", stripeSessionId: session.id } });
    if (!booking.confirmationEmailSentAt) {
      // Stable event IDs deduplicate webhook retries. The mail function also checks the DB.
      await sendEvent({ id: `booking-paid-${booking._id}`, name: "app/show.booked", data: { bookingId: booking._id.toString() } });
    }
    return true;
  }

  async function expire(bookingId) {
    const booking = await bookings.findById(bookingId);
    if (!booking || booking.isPaid) return;
    let session = null;
    if (booking.checkoutAttempted || booking.stripeSessionId || booking.paymentLink) {
      const stripe = stripeFactory();
      session = await recoverSession(booking, stripe);
      if (session?.status === "open") {
        try { session = await stripe.checkout.sessions.expire(session.id); }
        catch { session = await stripe.checkout.sessions.retrieve(session.id); }
      }
      if (session?.payment_status === "paid") return confirm(session);
      // A completed session may still have an asynchronous payment in progress.
      if (session && session.status !== "expired") throw new Error("Payment is still processing; seats remain reserved");
    }
    await releaseSeats(booking);
  }

  async function failPayment(session) {
    const booking = await bookings.findById(session.metadata?.bookingId);
    if (!booking || booking.isPaid || session.payment_status === "paid") return;
    if (booking.stripeSessionId !== session.id) throw new Error("Stripe session does not match the booking");
    await releaseSeats(booking);
  }

  async function create({ userId, showId, selectedSeats, origin }) {
    if (!userId) throw error(401, "Please sign in to book tickets");
    if (typeof showId !== "string" || !/^[a-f\d]{24}$/i.test(showId) || !Array.isArray(selectedSeats) ||
        selectedSeats.length < 1 || selectedSeats.length > 5 || new Set(selectedSeats).size !== selectedSeats.length ||
        selectedSeats.some((seat) => typeof seat !== "string" || !/^[A-J][1-9]$/.test(seat))) {
      throw error(400, "Select 1 to 5 valid, different seats");
    }
    const show = await shows.findById(showId).populate("movie");
    if (!show?.movie || new Date(show.showDateTime) <= new Date()) throw error(404, "Show is unavailable or has already started");
    const centsPerSeat = Math.round(show.showPrice * 100);
    if (!Number.isSafeInteger(centsPerSeat) || centsPerSeat < 50) throw error(400, "Invalid ticket price");
    const booking = new bookings({
      user: userId, show: showId, bookedSeats: selectedSeats,
      amount: centsPerSeat * selectedSeats.length / 100,
      expiresAt: new Date(Date.now() + HOLD_MS), checkoutOrigin: origin,
      checkoutTitle: show.movie.title,
      // Stripe requires at least 30 minutes here. Inngest explicitly expires it at 10 minutes.
      checkoutExpiresAt: new Date(Date.now() + 31 * 60 * 1000),
    });
    const filter = { _id: showId, showDateTime: { $gt: new Date() } };
    const occupied = {};
    for (const seat of selectedSeats) {
      filter[`occupiedSeats.${seat}`] = { $exists: false };
      occupied[`occupiedSeats.${seat}`] = userId;
      occupied[`seatBookings.${seat}`] = booking._id.toString();
    }
    await booking.save();
    const reserved = await shows.findOneAndUpdate(filter, { $set: occupied }, { new: true });
    if (!reserved) {
      await bookings.deleteOne({ _id: booking._id });
      throw error(409, "Selected seats are not available");
    }
    try {
      const stripe = stripeFactory();
      booking.checkoutAttempted = true;
      await booking.save();
      let session;
      try {
        session = await stripe.checkout.sessions.create(sessionParams(booking), { idempotencyKey: `booking-${booking._id}` });
      } catch (failure) {
        // These responses establish that Stripe did not create a payment session.
        if (["StripeInvalidRequestError", "StripeAuthenticationError"].includes(failure.type)) {
          booking.checkoutAttempted = false;
          await booking.save();
        }
        throw failure;
      }
      booking.stripeSessionId = session.id;
      booking.paymentLink = session.url;
      await booking.save();
      try {
        await sendEvent({ id: `booking-expiry-${booking._id}`, name: "app/checkpayment", data: { bookingId: booking._id.toString(), expiresAt: booking.expiresAt.toISOString() } });
      } catch (failure) {
        // The Inngest expiry sweep recovers missed events without creating a second booking.
        console.error("Booking expiry event will be recovered by the sweep:", failure.message);
      }
      return { success: true, url: session.url };
    } catch (failure) {
      try { await expire(booking._id); }
      catch (cleanupError) { console.error("Seats remain reserved until Stripe reconciliation:", cleanupError.message); }
      throw failure;
    }
  }
  return { create, confirm, expire, failPayment };
}

export const bookingService = createBookingService();
