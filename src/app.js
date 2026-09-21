import express from "express";


const app = express();    //Create express application
const PORT = 3000;

app.use(express.json());

app.get("/health", (req, res) => {


    res.json({
        status: "OK",
        message: "Emlynk backend is running..!"
    });


});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT} `);
});
