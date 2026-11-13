import { clerkClient } from "@clerk/express";
export const protectUser = (req, res, next) => {
  if (!req.auth().userId) return res.status(401).json({ success: false, message: "Please sign in" });
  next();
};
export const protectAdmin = async (req, res, next) => {
  try {
    const { userId } = req.auth();
    if (!userId) return res.status(401).json({ success: false, isAdmin: false, message: "Please sign in" });
    const user = await clerkClient.users.getUser(userId);

    if (user.privateMetadata.role !== "admin") {
      return res.json({
        success: false,
        message: "not authorized",
      });
    }
    next();
  } catch (error) {
    return res.json({
      success: false,
      message: "not authorized",
    });
  }
};
