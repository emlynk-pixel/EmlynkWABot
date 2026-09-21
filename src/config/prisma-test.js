import prisma from "./prisma.js";

try{
    const result = await prisma.$queryRaw`SELECT current_database()`;
    console.log("Database connection successfull!", result);
} catch ( error ){
    console.log("Database connection failed!" , error.message)
}finally{

    //closing connection after testing
    await prisma.$disconnect();
}

