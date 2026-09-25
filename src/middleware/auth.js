import jwt from "jsonwebtoken";

export const JWT_ALGORITHM = "HS256";

// Require a valid "Bearer <JWT>" header and attach its payload to req.admin.
export function authenticateAdmin(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
            message: "Authentication Token is required!",
        });
    }

    const token = authHeader.split(" ")[1];

    try {
        // Only the algorithm tokens are signed with: rules out "none" and
        // algorithm-confusion tricks.
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: [JWT_ALGORITHM] });

        req.admin = decoded;
        next();
    } catch (error) {
        return res.status(401).json({
            message: "Invalid or Expired Token",
        });
    }
}
