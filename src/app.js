import express from "express";
import "dotenv/config"
import authRoutes from "./routes/auth.js";
import whatsappRoutes from "./routes/whatsapp.js";


const app = express();    //Create express application


app.use(

    express.json({    //Parse incoming request bodies to JSON
        verify: (req, res, buffer) => {
            req.rawBody = buffer;  //Store raw body for signature verification
        },
    })

); 

app.use("/auth", authRoutes);  //Authentication routes
app.use("/whatsapp", whatsappRoutes);  //Whatsapp intergration routes

app.get("/health", (req, res) => {


    res.json({
        status: "OK",
        message: "Emlynk backend is running..!"
    });


});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT} `); 
});
