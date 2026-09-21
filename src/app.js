import express from "express";
import authRoutes from "./routes/auth.js";


const app = express();    //Create express application
const PORT = 3000;

app.use(express.json());

app.use("/auth", authRoutes);

app.get("/health", (req, res) => {


    res.json({
        status: "OK",
        message: "Emlynk backend is running..!"
    });


});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT} `);
});
