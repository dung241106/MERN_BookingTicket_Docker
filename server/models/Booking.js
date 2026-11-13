import mongoose from "mongoose";

const bookingSchema = new mongoose.Schema(
  {
    user: { type: String, required: true, ref: "User" },
    show: { type: String, required: true, ref: "Show" },
    amount: { type: Number, required: true },
    bookedSeats: { type: Array, required: true },
    isPaid: { type: Boolean, default: false },
    paymentLink: { type: String },
    stripeSessionId: String,
    expiresAt: { type: Date, index: true },
    checkoutOrigin: String,
    checkoutTitle: String,
    checkoutExpiresAt: Date,
    checkoutAttempted: { type: Boolean, default: false },
    confirmationEmailSentAt: Date,
    reminderSentAt: Date,
  },
  { timestamps: true }
);
const Booking = mongoose.model("Booking", bookingSchema);
export default Booking;
