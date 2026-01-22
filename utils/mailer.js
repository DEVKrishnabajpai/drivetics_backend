const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.ADMIN_EMAIL,
    pass: process.env.ADMIN_EMAIL_PASSWORD,
  },
});

const sendAdminEmail = async (subject, message) => {
  try {
    await transporter.sendMail({
      from: `"Drivetics 🚚" <${process.env.ADMIN_EMAIL}>`,
      to: process.env.ADMIN_EMAIL,
      subject: subject,
      text: message,
    });
    console.log("📧 Admin email sent");
  } catch (error) {
    console.error("❌ Email error:", error.message);
  }
};

module.exports = sendAdminEmail;
