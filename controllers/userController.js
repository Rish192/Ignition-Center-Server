import User from "../models/userModel.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export const register = async (req, res) => {
    try {
        const { email, password } = req.body;

        const existingUser = await User.findOne({email});
        if (existingUser) return res.status(400).json({message: "User already exists"});

        //Determine role based on email domain
        const role = email.endsWith("@kpmg.com") ? "admin" : "guest";

        //Hash password
        const hashedPassword = await bcrypt.hash(password, 12);

        const newUser = await User.create({email, password: hashedPassword, role});

        const token = jwt.sign(
            {email: newUser.email, id: newUser._id, role: newUser.role},
            process.env.JWT_SECRET,
            {expiresIn: "1h"}
        );

        res.status(201).json({result: newUser, token});
    } catch (error) {
        res.status(500).json({message: "Something went wrong"});
    }
};

export const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({email});
        if (!user) return res.status(404).json({message: "User not found"});

        const isPasswordCorrect = await bcrypt.compare(password, user.password);
        if (!isPasswordCorrect) return res.status(400).json({message: "Invalid Credentials"});

        const token = jwt.sign(
            {
                email: user.email,
                id: user._id,
                role: user.role
            },
            process.env.JWT_SECRET,
            {expiresIn: "1h"}
        );
        
        res.status(200).json({result: user, token});
    } catch (error) {
        res.status(500).json({message: "Something went wrong"});
    }
};