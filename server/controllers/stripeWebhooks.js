import Stripe from "stripe";
import { bookingService } from "../services/bookingService.js";

export const stripeWebhooks = async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send("Stripe webhook is not configured");
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.status(400).send("Invalid webhook signature");
  }
  try {
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      await bookingService.confirm(event.data.object);
    } else if (event.type === "payment_intent.succeeded") {
      // Keep compatibility with the existing Stripe endpoint subscription.
      const sessions = await stripe.checkout.sessions.list({ payment_intent: event.data.object.id, limit: 1 });
      if (sessions.data[0]) await bookingService.confirm(sessions.data[0]);
    } else if (event.type === "checkout.session.async_payment_failed") {
      await bookingService.failPayment(event.data.object);
    } else if (event.type === "checkout.session.expired") {
      const bookingId = event.data.object.metadata?.bookingId;
      if (bookingId) await bookingService.expire(bookingId);
    }
    res.json({ received: true });
  } catch (error) {
    console.error("Webhook processing error:", error.message);
    res.status(500).send("Webhook processing failed; please retry");
  }
};
