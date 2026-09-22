import express from "express";
import authRoutes from "./routes/auth.js";
import whatsappRoutes from "./routes/whatsapp.js";


const app = express();    //Create express application
const PORT = 3000;

app.use(express.json()); //Parse incoming request bodies to JSON

app.use("/auth", authRoutes);  //Authentication routes
app.use("/whatsapp", whatsappRoutes);  //Whatsapp intergration routes

app.get("/health", (req, res) => {


    res.json({
        status: "OK",
        message: "Emlynk backend is running..!"
    });


});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT} `); 
});
