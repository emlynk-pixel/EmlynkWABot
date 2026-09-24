import express from "express";
import jwt from "jsonwebtoken";

import prisma from "../config/prisma.js";
import { comparePassword } from "../utils/password.js";
import { authenticateAdmin } from "../middleware/auth.js";

const router = express.Router();

// Admin login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required",
      });
    }

    const admin = await prisma.admin.findUnique({
      where: { email },
    });

    // Same message for unknown email and wrong password, so emails can't be probed.
    if (!admin || !admin.passwordHash) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    const passwordMatches = await comparePassword(
      password,
      admin.passwordHash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    const token = jwt.sign(
      {
        adminId: admin.adminId,
        email: admin.email,
        role: admin.role,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "1h",
      }
    );

    return res.status(200).json({
      message: "Login successful",
      token,
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
});

// Current admin's profile, looked up from the token's adminId.
router.get("/me", authenticateAdmin, async (req, res) => {
  try {
    const admin = await prisma.admin.findUnique({
      where: {
        adminId: req.admin.adminId,
      },
      select: {
        adminId: true,
        email: true,
        name: true,
        role: true,
        status: true,
      },
    });

    if (!admin) {
      return res.status(404).json({
        message: "Admin not found!",
      });
    }

    return res.status(200).json({
      message: "Admin profile successfully fetched",
      admin,
    });
  } catch (error) {
    console.error("Protected admin route error", error.message);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
});

export default router;
