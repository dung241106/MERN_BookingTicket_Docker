import User from "../models/User.js";
import Booking from "../models/Booking.js";
import Show from "../models/Show.js";
import sendEmail from "../config/nodeMailer.js";
import { inngest } from "./client.js";
import { bookingService } from "../services/bookingService.js";
export { inngest } from "./client.js";

const zone = process.env.APP_TIMEZONE || "Asia/Ho_Chi_Minh";
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const userData = ({ id, first_name, last_name, email_addresses, image_url }) => ({
  _id: id, name: [first_name, last_name].filter(Boolean).join(" ") || email_addresses[0].email_address,
  email: email_addresses[0].email_address, image: image_url,
});

const syncUserCreation = inngest.createFunction(
  { id: "sync - user - from - clerk" }, { event: "clerk/user.created" },
  async ({ event }) => {
    const data = userData(event.data);
    await User.findByIdAndUpdate(data._id, data, { upsert: true, runValidators: true });
  }
);
const syncUserDeletion = inngest.createFunction(
  { id: "delete-user-with-clerk" }, { event: "clerk/user.deleted" },
  async ({ event }) => { await User.findByIdAndDelete(event.data.id); }
);
const syncUserUpdation = inngest.createFunction(
  { id: "update-user-from-clerk" }, { event: "clerk/user.updated" },
  async ({ event }) => {
    const data = userData(event.data);
    await User.findByIdAndUpdate(data._id, data, { upsert: true, runValidators: true });
  }
);

const releaseSeatsAndDeleteBooking = inngest.createFunction(
  { id: "release-seats-delete-booking" }, { event: "app/checkpayment" },
  async ({ event, step }) => {
    const booking = await step.run("get-booking-deadline", async () => {
      const row = await Booking.findById(event.data.bookingId).lean();
      return row && { id: row._id.toString(), expiresAt: (row.expiresAt || new Date(row.createdAt.getTime() + 10 * 60 * 1000)).toISOString() };
    });
    if (!booking) return;
    await step.sleepUntil("wait-for-10-minutes", new Date(booking.expiresAt));
    await step.run("check-payment-status", () => bookingService.expire(booking.id));
  }
);

// Recover an expiry event lost during a temporary event-service/network failure.
const recoverPendingBookings = inngest.createFunction(
  { id: "recover-pending-bookings" }, { cron: "*/5 * * * *" },
  async ({ step }) => {
    const ids = await step.run("find-expired-bookings", async () => {
      const rows = await Booking.find({ isPaid: false, $or: [
        { expiresAt: { $lte: new Date() } },
        { expiresAt: null, createdAt: { $lte: new Date(Date.now() - 10 * 60 * 1000) } },
      ] }).select("_id").limit(100).lean();
      return rows.map((row) => row._id.toString());
    });
    const expiryResults = await Promise.allSettled(ids.map((id) => step.run(`expire-${id}`, () => bookingService.expire(id))));
    // Recover paid bookings whose confirmation event could not be delivered.
    const paidIds = await step.run("find-unqueued-confirmations", async () => {
      const rows = await Booking.find({ isPaid: true, confirmationEmailSentAt: null }).select("_id").limit(100).lean();
      return rows.map((row) => row._id.toString());
    });
    for (const id of paidIds) await step.sendEvent(`confirm-${id}`, { id: `booking-paid-${id}`, name: "app/show.booked", data: { bookingId: id } });
    const failed = expiryResults.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
);

const sendBookingConfirmationEmail = inngest.createFunction(
  { id: "send-booking-confirmation-email", concurrency: { limit: 1, key: "event.data.bookingId" } },
  { event: "app/show.booked" },
  async ({ event, step }) => {
    const { bookingId } = event.data;
    const details = await step.run("load-paid-booking", async () => {
      const booking = await Booking.findById(bookingId).populate({ path: "show", populate: { path: "movie" } }).populate("user");
      if (!booking?.isPaid || booking.confirmationEmailSentAt) return null;
      if (!booking.user || !booking.show?.movie) throw new Error("Booking user/movie has not been synchronized yet");
      return { to: booking.user.email, name: booking.user.name, title: booking.show.movie.title, time: booking.show.showDateTime.toISOString() };
    });
    if (!details) return;
    await step.run("send-confirmation", () => sendEmail({
      to: details.to, subject: `Payment Confirmation: "${details.title}" booked!`,
      body: `<div style="font-family:Arial,sans-serif;line-height:1.5"><h2>Hi ${escapeHtml(details.name)},</h2><p>Your booking for <strong>${escapeHtml(details.title)}</strong> is confirmed.</p><p>Date and time: ${new Date(details.time).toLocaleString("en-US", { timeZone: zone })}</p><p>Enjoy the show! — QuickShow Team</p></div>`,
    }));
    await step.run("mark-confirmation-sent", () => Booking.updateOne({ _id: bookingId }, { $set: { confirmationEmailSentAt: new Date() } }));
  }
);

const sendShowReminders = inngest.createFunction(
  { id: "send-show-reminders", concurrency: 1 }, { cron: "*/10 * * * *" },
  async ({ step }) => {
    const tasks = await step.run("prepare-reminder-tasks", async () => {
      const now = new Date();
      const shows = await Show.find({ showDateTime: { $gt: now, $lte: new Date(now.getTime() + 8 * 60 * 60 * 1000) } }).populate("movie");
      const tasks = [];
      for (const show of shows) {
        if (!show.movie) continue;
        const bookings = await Booking.find({ show: show._id.toString(), isPaid: true, reminderSentAt: null }).lean();
        const userIds = [...new Set(bookings.map((booking) => booking.user))];
        const users = await User.find({ _id: { $in: userIds } }).lean();
        for (const user of users) tasks.push({
          key: `${show._id}-${user._id}`, email: user.email, name: user.name,
          title: show.movie.title, time: show.showDateTime.toISOString(),
          bookingIds: bookings.filter((booking) => booking.user === user._id).map((booking) => booking._id.toString()),
        });
      }
      return tasks;
    });
    for (const task of tasks) {
      await step.run(`remind-${task.key}`, () => sendEmail({
        to: task.email, subject: `Reminder: your movie "${task.title}" starts soon!`,
        body: `<div style="font-family:Arial,sans-serif"><h2>Hi ${escapeHtml(task.name)},</h2><p>Your movie <strong>${escapeHtml(task.title)}</strong> starts at ${new Date(task.time).toLocaleString("en-US", { timeZone: zone })}.</p><p>Enjoy the show! — QuickShow Team</p></div>`,
      }));
      await step.run(`mark-reminded-${task.key}`, () => Booking.updateMany({ _id: { $in: task.bookingIds } }, { $set: { reminderSentAt: new Date() } }));
    }
    return { sent: tasks.length };
  }
);

const sendNewShowNotifications = inngest.createFunction(
  { id: "send-new-show-notifications" }, { event: "app/show.added" },
  async ({ event, step }) => {
    const users = await step.run("load-users", () => User.find({}).select("name email").lean());
    for (const user of users) await step.run(`notify-${user._id}`, () => sendEmail({
      to: user.email, subject: `New Show Added: ${event.data.movieTitle}`,
      body: `<div style="font-family:Arial,sans-serif"><h2>Hi ${escapeHtml(user.name)},</h2><p>We've just added a new show: <strong>${escapeHtml(event.data.movieTitle)}</strong>.</p><p>Visit our website. — QuickShow Team</p></div>`,
    }));
    return { sent: users.length };
  }
);

export const functions = [syncUserCreation, syncUserDeletion, syncUserUpdation, releaseSeatsAndDeleteBooking, recoverPendingBookings, sendBookingConfirmationEmail, sendShowReminders, sendNewShowNotifications];
