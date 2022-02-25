import dotenv from 'dotenv';

// configure from dotenv
dotenv.config();

export const stackToken = process.env.SLACK_TOKEN;
export const frontendUrl = process.env.FRONTEND_BASE_URL;