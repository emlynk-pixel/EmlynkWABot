import bcrypt from "bcrypt";

const SALT_ROUNDS = 10;


//conver plain text pass to hash
export async function hashPassword(password){
    return bcrypt.hash(password, SALT_ROUNDS);

}


//compare plaintext password with stored bcrypt hash pass
export async function comparePassword(password, passwordHash){
    return bcrypt.compare(password, passwordHash);
}
