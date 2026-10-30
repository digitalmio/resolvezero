import "@tanstack/react-start/server-only";

import nodemailer, { type Transporter } from "nodemailer";

import { otpEmail, type OtpType } from "../lib/otp-email";

let cached: Transporter | null | undefined;

/** True when an SMTP endpoint is configured (production requirement). */
export function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_URL?.trim());
}

function devLoggingEnabled(): boolean {
  return process.env.EMAIL_OTP_DEV_LOG === "1" || process.env.NODE_ENV !== "production";
}

function transporter(): Transporter | null {
  if (cached !== undefined) return cached;

  const url = process.env.SMTP_URL?.trim();
  if (!url) {
    if (!devLoggingEnabled()) {
      throw new Error(
        "SMTP_URL is required in production: email OTP is the only human sign-in method",
      );
    }
    cached = null;
    return null;
  }

  cached = nodemailer.createTransport(url);
  return cached;
}

/**
 * Send an OTP email. In development without SMTP the code is logged instead, so
 * the flow is testable without a mail server. Production refuses to send (and
 * fails loudly) when SMTP is missing.
 */
export async function sendOtpEmail(to: string, otp: string, type: OtpType): Promise<void> {
  const message = otpEmail(otp, type);
  const from = process.env.EMAIL_FROM?.trim() || "ResolveZero <no-reply@resolvezero.local>";
  const transport = transporter();

  if (!transport) {
    console.info(
      JSON.stringify({ level: "info", msg: "otp email (dev, not sent)", to, code: otp }),
    );
    return;
  }

  await transport.sendMail({
    from,
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}
