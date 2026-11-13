import Show from "../models/Show.js";
import { bookingService } from "../services/bookingService.js";

export const createBooking = async (req, res) => {
  try {
    const { userId } = req.auth();
    const allowed = (process.env.FRONTEND_URL || "http://localhost:5173").split(",").map((url) => url.trim().replace(/\/$/, ""));
    const origin = req.headers.origin || allowed[0];
    if (!allowed.includes(origin)) return res.status(400).json({ success: false, message: "Frontend origin is not configured" });
    const result = await bookingService.create({ ...req.body, userId, origin });
    res.json(result);
  } catch (error) {
    console.error(error.message);
    res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Could not start checkout. Please try again." });
  }
};

export const getOccupiedSeats = async (req, res) => {
  try {
    const show = await Show.findById(req.params.showId);
    if (!show) return res.status(404).json({ success: false, message: "Show not found" });
    res.json({ success: true, occupiedSeats: Object.keys(show.occupiedSeats) });
  } catch {
    res.status(400).json({ success: false, message: "Invalid show ID" });
  }
};
