import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import mongoose from "mongoose";
import Show from "../models/Show.js";
import Movie from "../models/Movie.js";
import Booking from "../models/Booking.js";
import User from "../models/User.js";
import nodemailer from "nodemailer";
import Stripe from "stripe";
import { bookingService, createBookingService } from "../services/bookingService.js";

let mongoProcess, mongoDirectory;
before(async () => {
  let uri = process.env.TEST_MONGODB_URL;
  if (!uri) {
    mongoDirectory = await mkdtemp(join(tmpdir(), "quickshow-regression-"));
    const socket = createServer();
    await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    mongoProcess = spawn(process.env.MONGOD_BINARY || "mongod", ["--dbpath", mongoDirectory, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore", windowsHide: true });
    let startError;
    mongoProcess.on("error", (error) => { startError = error; });
    uri = `mongodb://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (startError) throw new Error("Install mongod or set TEST_MONGODB_URL to a dedicated test MongoDB server");
      try {
        await mongoose.connect(uri, { dbName: `quickshow_regression_${process.pid}`, serverSelectionTimeoutMS: 200 });
        return;
      } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    throw new Error("Test MongoDB did not start");
  }
  await mongoose.connect(uri, { dbName: `quickshow_regression_${process.pid}`, serverSelectionTimeoutMS: 5000 });
});
after(async () => {
  if (mongoose.connection.readyState === 1 && /^quickshow_regression_\d+$/.test(mongoose.connection.name)) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (mongoProcess && mongoProcess.exitCode === null) {
    const stopped = new Promise((resolve) => mongoProcess.once("exit", resolve));
    mongoProcess.kill();
    await stopped;
  }
  if (mongoDirectory) await rm(mongoDirectory, { recursive: true, force: true });
});
beforeEach(async () => { await Promise.all([Show.deleteMany({}), Booking.deleteMany({}), Movie.deleteMany({}), User.deleteMany({})]); });

async function fixture({ price = 8.5, future = true } = {}) {
  await Movie.create({ _id: "123", title: "Test Movie", overview: "Test", poster_path: "/test.jpg", backdrop_path: "/test.jpg", release_date: "2026-01-01", genres: [], casts: [], vote_average: 7, runtime: 100 });
  const show = await Show.create({ movie: "123", showDateTime: new Date(Date.now() + (future ? 3600000 : -3600000)), showPrice: price });
  const sessions = new Map(), keys = new Map(), events = [], calls = [];
  const stripe = { checkout: { sessions: {
    create: async (params, options) => {
      calls.push(params);
      if (keys.has(options.idempotencyKey)) return sessions.get(keys.get(options.idempotencyKey));
      const id = `cs_test_${sessions.size + 1}`;
      const session = { id, status: "open", payment_status: "unpaid", currency: "usd", amount_total: params.line_items[0].price_data.unit_amount, metadata: params.metadata, url: `https://checkout.stripe.com/${id}` };
      sessions.set(id, session); keys.set(options.idempotencyKey, id);
      return session;
    },
    retrieve: async (id) => structuredClone(sessions.get(id)),
    expire: async (id) => {
      const session = sessions.get(id);
      if (session.status !== "open") throw new Error("Session is not open");
      session.status = "expired";
      return structuredClone(session);
    },
  } } };
  const service = createBookingService({ stripeFactory: () => stripe, sendEvent: async (event) => { events.push(event); } });
  const create = (seats = ["A1"], userId = "user_one") => service.create({ userId, showId: show._id.toString(), selectedSeats: seats, origin: "http://localhost:5173" });
  return { show, sessions, events, calls, stripe, service, create };
}

test("preserves decimal ticket prices and sends the expiry event as data", async () => {
  const f = await fixture(); await f.create(["A1", "A2"]);
  const booking = await Booking.findOne();
  assert.equal(booking.amount, 17); assert.equal(f.calls[0].line_items[0].price_data.unit_amount, 1700);
  assert.equal(f.events[0].data.bookingId, booking.id); assert.ok(f.events[0].data.expiresAt);
  assert.equal((await Show.findById(f.show._id)).occupiedSeats.A1, "user_one");
});
test("one concurrent buyer wins a contested seat", async () => {
  const f = await fixture(); const results = await Promise.allSettled([f.create(["A1"], "one"), f.create(["A1"], "two")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  assert.equal(await Booking.countDocuments(), 1); assert.equal(f.sessions.size, 1);
});
test("concurrent different seats do not overwrite each other", async () => {
  const f = await fixture(); await Promise.all([f.create(["A1"]), f.create(["B1"], "two")]);
  assert.deepEqual(Object.keys((await Show.findById(f.show._id)).occupiedSeats).sort(), ["A1", "B1"]);
});
test("a multi-seat request is all or nothing", async () => {
  const f = await fixture(); await f.create(["A1"]);
  await assert.rejects(f.create(["A1", "A2"], "two"), { status: 409 });
  assert.equal((await Show.findById(f.show._id)).occupiedSeats.A2, undefined);
});
test("invalid and duplicate seats are rejected; authentication is required", async () => {
  const f = await fixture();
  for (const seats of [[], ["A1", "A1"], ["Z99"], ["__proto__"], ["A1", "A2", "A3", "A4", "A5", "A6"]]) await assert.rejects(f.create(seats), { status: 400 });
  await assert.rejects(f.create(["A1"], null), { status: 401 }); assert.equal(await Booking.countDocuments(), 0);
});
test("past shows cannot be booked", async () => {
  const f = await fixture({ future: false }); await assert.rejects(f.create(), { status: 404 });
});
test("a definite Stripe failure rolls back the held seats", async () => {
  const f = await fixture(); f.stripe.checkout.sessions.create = async () => { throw Object.assign(new Error("Invalid API key"), { type: "StripeAuthenticationError" }); };
  await assert.rejects(f.create());
  assert.deepEqual((await Show.findById(f.show._id)).occupiedSeats, {}); assert.equal(await Booking.countDocuments(), 0);
});
test("a lost Stripe response is recovered with the same idempotency key and closed before release", async () => {
  const f = await fixture(); const create = f.stripe.checkout.sessions.create; let first = true;
  f.stripe.checkout.sessions.create = async (...args) => { const session = await create(...args); if (first) { first = false; throw new Error("Network timeout after session creation"); } return session; };
  await assert.rejects(f.create());
  assert.equal(f.sessions.size, 1); assert.equal([...f.sessions.values()][0].status, "expired");
  assert.deepEqual((await Show.findById(f.show._id)).occupiedSeats, {});
});
test("expiry closes unpaid Stripe checkout before releasing and deleting a booking", async () => {
  const f = await fixture(); await f.create(); const booking = await Booking.findOne();
  await f.service.expire(booking.id);
  assert.equal(f.sessions.get(booking.stripeSessionId).status, "expired"); assert.equal(await Booking.countDocuments(), 0);
  await f.create(["A1"]); await f.service.expire(booking.id);
  assert.equal((await Show.findById(f.show._id)).occupiedSeats.A1, "user_one");
});
test("a paid session with delayed webhook keeps its seats and confirms the booking", async () => {
  const f = await fixture(); await f.create(); const booking = await Booking.findOne();
  Object.assign(f.sessions.get(booking.stripeSessionId), { status: "complete", payment_status: "paid" });
  await f.service.expire(booking.id);
  assert.equal((await Booking.findById(booking.id)).isPaid, true);
  assert.ok((await Show.findById(f.show._id)).occupiedSeats.A1);
});
test("webhook retries use a stable notification ID and sent mail is not enqueued again", async () => {
  const f = await fixture(); await f.create(); const session = [...f.sessions.values()][0];
  Object.assign(session, { status: "complete", payment_status: "paid" });
  await f.service.confirm(session); await f.service.confirm(session);
  const notifications = f.events.filter((e) => e.name === "app/show.booked");
  assert.equal(notifications[0].id, notifications[1].id);
  await Booking.updateOne({ _id: session.metadata.bookingId }, { confirmationEmailSentAt: new Date() });
  await f.service.confirm(session); assert.equal(f.events.filter((e) => e.name === "app/show.booked").length, 2);
});
test("a wrong Stripe amount cannot mark a booking as paid", async () => {
  const f = await fixture(); await f.create(); const session = [...f.sessions.values()][0];
  Object.assign(session, { status: "complete", payment_status: "paid", amount_total: 1 });
  await assert.rejects(f.service.confirm(session), /does not match/);
  assert.equal((await Booking.findOne()).isPaid, false);
});
test("pending asynchronous payment is never released just because the timer elapsed", async () => {
  const f = await fixture(); await f.create(); const booking = await Booking.findOne();
  f.sessions.get(booking.stripeSessionId).status = "complete";
  await assert.rejects(f.service.expire(booking.id), /still processing/);
  assert.equal(await Booking.countDocuments(), 1); assert.ok((await Show.findById(f.show._id)).occupiedSeats.A1);
});
test("an Inngest outage after checkout creation still returns the existing payment link", async () => {
  const f = await fixture();
  const service = createBookingService({ stripeFactory: () => f.stripe, sendEvent: async () => { throw new Error("Inngest offline"); } });
  const result = await service.create({ userId: "one", showId: f.show.id, selectedSeats: ["A1"], origin: "http://localhost:5173" });
  assert.equal(result.success, true); assert.equal(await Booking.countDocuments(), 1);
  await service.expire((await Booking.findOne()).id); assert.equal(await Booking.countDocuments(), 0);
});

test("a legacy payment URL is reconciled before an old seat is released", async () => {
  const f = await fixture(); await f.create(); const booking = await Booking.findOne();
  await Booking.updateOne({ _id: booking._id }, { $unset: { stripeSessionId: "", checkoutAttempted: "", checkoutOrigin: "", checkoutTitle: "", checkoutExpiresAt: "", expiresAt: "" } });
  await Show.updateOne({ _id: f.show._id }, { $unset: { seatBookings: "" } });
  await f.service.expire(booking.id);
  assert.equal(f.sessions.get(booking.stripeSessionId).status, "expired");
  assert.deepEqual((await Show.findById(f.show._id)).occupiedSeats, {});
});

test("a definitive asynchronous payment failure releases its own hold", async () => {
  const f = await fixture(); await f.create(); const session = [...f.sessions.values()][0];
  session.status = "complete"; await f.service.failPayment(session);
  assert.equal(await Booking.countDocuments(), 0); assert.deepEqual((await Show.findById(f.show._id)).occupiedSeats, {});
});

test("show list earnings count only paid bookings, not held seats", async () => {
  const f = await fixture(); await f.create(["A1"]); await f.create(["B1", "B2"], "two");
  await Booking.updateOne({ user: "two" }, { isPaid: true });
  const { getAllShows } = await import("../controllers/adminControllers.js");
  let result; await getAllShows({}, { json: (data) => { result = data; } });
  assert.equal(result.shows[0].paidSeats, 2); assert.equal(result.shows[0].earnings, 17);
});

test("show dates group by Vietnam day rather than UTC day", async () => {
  const f = await fixture(); await Show.updateOne({ _id: f.show._id }, { showDateTime: new Date("2099-01-01T18:00:00Z") });
  const { getShow } = await import("../controllers/showControllers.js");
  let result; await getShow({ params: { movieId: "123" } }, { json: (data) => { result = data; } });
  assert.equal(Object.keys(result.dateTime)[0], "2099-01-02"); assert.equal(result.dateTime["2099-01-02"][0].showPrice, 8.5);
});

let sentMails = [];
async function registeredFunctions() {
  const original = nodemailer.createTransport;
  nodemailer.createTransport = () => ({ sendMail: async (message) => { sentMails.push(message); return { accepted: [message.to] }; } });
  try { return (await import("../inngest/index.js")).functions; }
  finally { nodemailer.createTransport = original; }
}
const steps = { run: async (id, action) => action() };

test("reminders use showDateTime, paid users only, and persist their sent state", async () => {
  const f = await fixture(); await f.create(["A1"]); await f.create(["B1"], "user_two");
  await User.create({ _id: "user_one", name: "Buyer", email: "buyer@example.test", image: "test" });
  await User.create({ _id: "user_two", name: "Unpaid", email: "unpaid@example.test", image: "test" });
  await Booking.updateOne({ user: "user_one" }, { isPaid: true });
  const fn = (await registeredFunctions()).find((item) => item.id() === "send-show-reminders");
  sentMails = [];
  assert.deepEqual(await fn.fn({ step: steps }), { sent: 1 });
  assert.equal(sentMails[0].to, "buyer@example.test");
  assert.deepEqual(await fn.fn({ step: steps }), { sent: 0 });
  assert.equal(sentMails.length, 1);
});

test("confirmation email is sent only for paid bookings and not on duplicate delivery", async () => {
  const f = await fixture(); await f.create();
  await User.create({ _id: "user_one", name: "Buyer", email: "buyer@example.test", image: "test" });
  const booking = await Booking.findOne();
  const fn = (await registeredFunctions()).find((item) => item.id() === "send-booking-confirmation-email");
  sentMails = [];
  await fn.fn({ event: { data: { bookingId: booking.id } }, step: steps }); assert.equal(sentMails.length, 0);
  await Booking.updateOne({ _id: booking.id }, { isPaid: true });
  await fn.fn({ event: { data: { bookingId: booking.id } }, step: steps });
  await fn.fn({ event: { data: { bookingId: booking.id } }, step: steps });
  assert.equal(sentMails.length, 1); assert.ok((await Booking.findById(booking.id)).confirmationEmailSentAt);
});

test("expiry waits for the saved deadline rather than restarting a ten minute timer", async () => {
  const f = await fixture(); await f.create(); const booking = await Booking.findOne();
  const fn = (await registeredFunctions()).find((item) => item.id() === "release-seats-delete-booking");
  const original = bookingService.expire; let expired, sleptUntil;
  bookingService.expire = async (id) => { expired = id; };
  try {
    await fn.fn({ event: { data: { bookingId: booking.id } }, step: { ...steps, sleepUntil: async (id, time) => { sleptUntil = time; } } });
    assert.equal(expired, booking.id); assert.equal(sleptUntil.getTime(), booking.expiresAt.getTime());
  } finally { bookingService.expire = original; }
});

test("webhook verifies the Stripe signature before processing a checkout", async () => {
  const { stripeWebhooks } = await import("../controllers/stripeWebhooks.js");
  const stripe = new Stripe("sk_test_regression");
  const secret = "whsec_regression";
  const originalKey = process.env.STRIPE_SECRET_KEY, originalSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const originalConfirm = bookingService.confirm;
  process.env.STRIPE_SECRET_KEY = "sk_test_regression"; process.env.STRIPE_WEBHOOK_SECRET = secret;
  let confirmed = 0;
  bookingService.confirm = async () => { confirmed++; };
  const body = Buffer.from(JSON.stringify({ id: "evt_test", type: "checkout.session.completed", data: { object: { id: "cs_test_1" } } }));
  const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json() {}, send() {} });
  try {
    const bad = response(); await stripeWebhooks({ body, headers: { "stripe-signature": "invalid" } }, bad);
    assert.equal(bad.code, 400); assert.equal(confirmed, 0);
    const signature = stripe.webhooks.generateTestHeaderString({ payload: body.toString(), secret });
    const good = response(); await stripeWebhooks({ body, headers: { "stripe-signature": signature } }, good);
    assert.equal(good.code, 200); assert.equal(confirmed, 1);
  } finally {
    bookingService.confirm = originalConfirm;
    if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = originalKey;
    if (originalSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
  }
});
