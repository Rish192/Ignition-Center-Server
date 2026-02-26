import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "./models/userModel.js";
import dotenv from "dotenv";

dotenv.config();

const usersToImport = [
    { email: "lokesh@kpmg.com", password: "lokesh123" },
    { email: "vivek@kpmg.com", password: "vivek123" }
];

const seedDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to DB for seeding...");

        for (let u of usersToImport) {
            // Check if user exists first to avoid duplicates
            const exists = await User.findOne({ email: u.email });
            if (!exists) {
                const hashedPassword = await bcrypt.hash(u.password, 12);
                const role = u.email.endsWith("@kpmg.com") ? "admin" : "guest";
                
                await User.create({ email: u.email, password: hashedPassword, role });
                console.log(`Created: ${u.email}`);
            }
        }

        console.log("Seeding complete!");
        process.exit();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

seedDB();