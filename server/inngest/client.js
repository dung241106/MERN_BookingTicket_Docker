import "../config/env.js";
import { Inngest } from "inngest";

// Keep Cloud mode even when the Express backend runs on the developer's machine.
export const inngest = new Inngest({ id: "movie-ticket-booking", isDev: false });
