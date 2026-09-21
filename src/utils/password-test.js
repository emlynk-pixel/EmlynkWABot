import { hashPassword,comparePassword} from "./password.js";


//Test password for verify
const password = "Admin#123";

//Hash  the plain text
const hash = await hashPassword(password);
console.log("hashpassword",hash);

//verfiy the password
const isCorrect = await comparePassword(password,hash);
console.log("password is correct",isCorrect);