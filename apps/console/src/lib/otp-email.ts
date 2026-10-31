export type OtpType = "sign-in" | "email-verification" | "forget-password" | "change-email";

export interface OtpEmail {
  subject: string;
  text: string;
  html: string;
}

const HEADINGS: Record<OtpType, string> = {
  "sign-in": "Your sign-in code",
  "email-verification": "Confirm your email",
  "forget-password": "Reset your access",
  "change-email": "Confirm your new email",
};

export function otpEmail(otp: string, type: OtpType, expiresMinutes = 10): OtpEmail {
  const heading = HEADINGS[type] ?? "Your code";
  const subject = `${otp} is your ResolveZero code`;

  const text = [
    heading,
    "",
    `Code: ${otp}`,
    "",
    `It expires in ${expiresMinutes} minutes and can be used once.`,
    "If you did not request this, you can ignore this email.",
    "",
    "ResolveZero — your DNS, your rules.",
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f2efe6;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#0b0b0a">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#fffdf8;border:1px solid rgba(11,11,10,0.28);border-top:4px solid #ff4d00">
      <tr>
        <td style="padding:28px">
          <p style="margin:0 0 6px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:#6b675e">${heading}</p>
          <p style="margin:0;font-size:34px;font-weight:800;letter-spacing:0.18em;font-variant-numeric:tabular-nums">${otp}</p>
          <p style="margin:18px 0 0;font-size:12px;line-height:1.7;color:#6b675e">
            It expires in ${expiresMinutes} minutes and can be used once.<br />
            If you did not request this, you can ignore this email.
          </p>
        </td>
      </tr>
    </table>
    <p style="max-width:480px;margin:16px auto 0;font-size:10px;color:#6b675e">ResolveZero — your DNS, your rules.</p>
  </body>
</html>`;

  return { subject, text, html };
}
