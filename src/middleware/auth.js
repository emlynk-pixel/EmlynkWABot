import jwt from "jsonwebtoken";


//Take JWT Authorization and verify
export function authenticateAdmin(req, res, next){
    const authHeader = req.headers.authorization;

    if(!authHeader || !authHeader.startsWith("Bearer ")){
        return res.status(401).json({
            message:"Authentication Token is required!",
        });
    }

    //extract the token from the header
    const token = authHeader.split(" ")[1];

    try{
        const decode = jwt.verify(token, process.env.JWT_SECRET);

        req.admin = decode;
        next();


    }catch(error){
        return res.status(401).json({
            message: "Invalid or Expired Token",
        });
    }
    
}