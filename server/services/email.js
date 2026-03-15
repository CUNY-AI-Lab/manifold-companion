// ---------------------------------------------------------------------------
// Email notifications via AWS SES
// ---------------------------------------------------------------------------

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const client = new SESv2Client({
  region: process.env.AWS_REGION || 'us-east-1',
});

const FROM_ADDRESS = process.env.SES_FROM_EMAIL || 'manifold-companion@cuny.qzz.io';
const APP_NAME = 'Manifold Companion';
const APP_URL = process.env.APP_URL || 'https://tools.cuny.qzz.io/manifold-companion';

function emailTemplate(title, bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e;">
  <div style="border-bottom: 2px solid #2563eb; padding-bottom: 12px; margin-bottom: 20px;">
    <strong style="font-size: 16px; color: #1a1a2e;">${APP_NAME}</strong>
  </div>
  <h2 style="font-size: 18px; margin: 0 0 12px; color: #1a1a2e;">${title}</h2>
  ${bodyHtml}
  <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af;">
    <a href="${APP_URL}" style="color: #2563eb;">Open ${APP_NAME}</a>
    &middot; You can manage notification preferences in your account settings.
  </div>
</body>
</html>`;
}

async function sendEmail(to, subject, htmlBody) {
  try {
    await client.send(new SendEmailCommand({
      FromEmailAddress: `${APP_NAME} <${FROM_ADDRESS}>`,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: emailTemplate(subject, htmlBody), Charset: 'UTF-8' },
          },
        },
      },
    }));
  } catch (err) {
    console.error(`[email] Failed to send to ${to}:`, err.message);
  }
}

export async function sendOcrCompleteEmail(to, projectName, textName) {
  await sendEmail(
    to,
    `OCR complete: ${textName}`,
    `<p>OCR processing has finished for <strong>${textName}</strong> in project <strong>${projectName}</strong>.</p>
     <p><a href="${APP_URL}" style="display: inline-block; padding: 8px 20px; background: #2563eb; color: white; text-decoration: none; border-radius: 20px; font-size: 14px;">Review Results</a></p>`
  );
}

export async function sendAccountApprovedEmail(to) {
  await sendEmail(
    to,
    'Your account has been approved',
    `<p>Your ${APP_NAME} account has been approved. You can now log in and start using the platform.</p>
     <p><a href="${APP_URL}" style="display: inline-block; padding: 8px 20px; background: #2563eb; color: white; text-decoration: none; border-radius: 20px; font-size: 14px;">Log In</a></p>`
  );
}

export async function sendProjectSharedEmail(to, ownerName, projectName, role) {
  await sendEmail(
    to,
    `${ownerName} shared a project with you`,
    `<p><strong>${ownerName}</strong> shared the project <strong>${projectName}</strong> with you as <strong>${role}</strong>.</p>
     <p><a href="${APP_URL}" style="display: inline-block; padding: 8px 20px; background: #2563eb; color: white; text-decoration: none; border-radius: 20px; font-size: 14px;">View Project</a></p>`
  );
}

export async function sendCommentReplyEmail(to, replierName, commentSnippet, textName) {
  const snippet = commentSnippet.length > 100 ? commentSnippet.slice(0, 100) + '...' : commentSnippet;
  await sendEmail(
    to,
    `${replierName} replied to your comment`,
    `<p><strong>${replierName}</strong> replied to your comment on <strong>${textName}</strong>:</p>
     <blockquote style="border-left: 3px solid #2563eb; padding-left: 12px; margin: 12px 0; color: #4b5563;">${snippet}</blockquote>
     <p><a href="${APP_URL}" style="display: inline-block; padding: 8px 20px; background: #2563eb; color: white; text-decoration: none; border-radius: 20px; font-size: 14px;">View Comment</a></p>`
  );
}

export async function sendMentionEmail(to, mentionerName, commentSnippet, textName) {
  const snippet = commentSnippet.length > 100 ? commentSnippet.slice(0, 100) + '...' : commentSnippet;
  await sendEmail(
    to,
    `${mentionerName} mentioned you in a comment`,
    `<p><strong>${mentionerName}</strong> mentioned you in a comment on <strong>${textName}</strong>:</p>
     <blockquote style="border-left: 3px solid #2563eb; padding-left: 12px; margin: 12px 0; color: #4b5563;">${snippet}</blockquote>
     <p><a href="${APP_URL}" style="display: inline-block; padding: 8px 20px; background: #2563eb; color: white; text-decoration: none; border-radius: 20px; font-size: 14px;">View Comment</a></p>`
  );
}
