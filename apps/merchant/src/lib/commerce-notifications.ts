import type { DOStub, Env } from '../types';
import { sendMailgunEmail } from '../mailgun';
export async function deliverServiceNotifications(
  env: Env,
  db: Pick<DOStub, 'commerceNotificationClaim' | 'commerceNotificationFinish'>,
) {
  if (!env.MAILGUN_API_KEY || !env.MAILGUN_DOMAIN) return;
  for (const job of await db.commerceNotificationClaim()) {
    let sent = false;
    try {
      const result = await sendMailgunEmail(env, {
        to: String(job.customer_email),
        subject: `Halifruit — cập nhật đơn ${job.number}`,
        text: `Yêu cầu hoặc hoàn tiền của đơn ${job.number} có cập nhật. Vui lòng mở đường dẫn theo dõi đơn đã được cung cấp để xem chi tiết. Gửi yêu cầu, duyệt yêu cầu và hoàn tiền là các bước riêng. Nếu cần hỗ trợ, hãy liên hệ shop.`,
      });
      sent = result.success;
    } catch {
      /* Delivery failure must never roll back an order or money ledger. */
    }
    await db.commerceNotificationFinish(String(job.id), sent);
  }
}
