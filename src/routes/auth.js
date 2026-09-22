import express from "express";
import jwt from "jsonwebtoken";

import prisma from "../config/prisma.js";
import { comparePassword } from "../utils/password.js";
import { authenticateAdmin } from "../middleware/auth.js";

const router = express.Router();

// Admin login endpoint
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Check if email and pw are missing
    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required",
      });
    }

    //Find admin record from DB using email
    const admin = await prisma.admin.findUnique({
      where: { email },
    });

    //if admin is not found return generic login error
    if (!admin || !admin.passwordHash) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    //compare the entered password with stored bcrypt hash
    const passwordMatches = await comparePassword(
      password,
      admin.passwordHash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    //Create JWT Token for successful login
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

export default router;


router.get("/me", authenticateAdmin, async (req,res) => {
  try{
    const admin = await prisma.admin.findUnique({
      where: {
        //finding the admin from DB using the token's AdminID
        adminId: req.admin.adminId,
      },
      select:{
        adminId: true,
        email: true,
        name: true,
        role: true,
        status: true,
      },

    });

    if(!admin){
      return res.status(404).json({
        message: "Admin not found!",
      });
    }

    return res.status(200).json({
      message: "Admin profile successfully fetched",
      admin,
    });


  }catch(error){
    console.error("Protected admin route error", error.message);

    return res.status(500).json({
       message: "Internal Server Error",
    });
  }
});


