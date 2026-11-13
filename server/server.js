import "./config/env.js";
import express from "express";
import cors from "cors";
import { pathToFileURL } from "node:url";
import connectDB from "./config/db.js";
import { clerkMiddleware } from "@clerk/express";
import { serve } from "inngest/express";
import { inngest, functions } from "./inngest/index.js";
import showRouter from "./routes/showRoutes.js";
import bookingRouter from "./routes/bookingRoutes.js";
import adminRouter from "./routes/adminRoutes.js";
import userRouter from "./routes/userRoutes.js";
import { protectAdmin } from "./middleware/auth.js";
import { stripeWebhooks } from "./controllers/stripeWebhooks.js";

const app = express();
app.post("/api/stripe", express.raw({ type: "application/json" }), stripeWebhooks);
app.use(express.json());
const origins = (process.env.FRONTEND_URL || "http://localhost:5173").split(",").map((url) => url.trim().replace(/\/$/, ""));
app.use(cors({ origin: origins }));
app.get("/", (req, res) => res.send("Server is live"));
app.use(clerkMiddleware());
app.use("/api/inngest", serve({ client: inngest, functions }));
app.use("/api/show", showRouter);
app.use("/api/booking", bookingRouter);
app.use("/api/admin", adminRouter);
app.use("/api/user", userRouter);

// Keep the test endpoint, but only administrators can trigger its existing mail event.
app.get("/test-new-show-notification", protectAdmin, async (req, res) => {
  try {
    await inngest.send({ name: "app/show.added", data: { movieTitle: "DEADPOOL & WOLVERINE" } });
    res.json({ success: true, message: "Notification event sent" });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ success: false, message: "Could not send notification event" });
  }
});

export async function startServer() {
  await connectDB();
  const port = Number(process.env.PORT || 3000);
  return app.listen(port, "0.0.0.0", () => console.log(`Server listening on port ${port}`));
}

if (process.env.VERCEL) {
  await connectDB();
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
export default app;
