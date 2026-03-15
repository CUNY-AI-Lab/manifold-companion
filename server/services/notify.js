// ---------------------------------------------------------------------------
// Notification dispatcher — creates in-app notification + sends email
// ---------------------------------------------------------------------------

import {
  createNotification,
  getNotificationPreferences,
  getProjectMembers,
  getUserById,
  getProjectShares,
} from '../db.js';
import {
  sendOcrCompleteEmail,
  sendAccountApprovedEmail,
  sendProjectSharedEmail,
  sendCommentReplyEmail,
  sendMentionEmail,
} from './email.js';

// Get user's email preference for a notification type
function shouldEmail(userId, type) {
  const prefs = getNotificationPreferences(userId);
  const key = `email_${type}`;
  return prefs[key] !== 0; // default to true if column missing
}

export function notifyOcrComplete(textId, textName, projectId, projectName, triggeredByUserId) {
  const members = getProjectMembers(projectId);
  for (const member of members) {
    createNotification(
      member.id,
      'ocr_complete',
      `OCR complete: ${textName}`,
      `OCR processing finished for "${textName}" in ${projectName}.`,
      `/texts/${textId}?tab=review`
    );
    if (shouldEmail(member.id, 'ocr_complete')) {
      sendOcrCompleteEmail(member.email, projectName, textName).catch((e) => console.error('[notify] email error:', e.message));
    }
  }
}

export function notifyAccountApproved(userId) {
  const user = getUserById(userId);
  if (!user) return;
  createNotification(
    userId,
    'account_approved',
    'Your account has been approved',
    'You can now log in and start using the platform.',
    '/'
  );
  sendAccountApprovedEmail(user.email).catch((e) => console.error('[notify] email error:', e.message));
}

export function notifyProjectShared(projectId, projectName, sharedUserId, role, ownerUserId) {
  const owner = getUserById(ownerUserId);
  const sharedUser = getUserById(sharedUserId);
  if (!owner || !sharedUser) return;
  const ownerName = owner.display_name || owner.email;
  createNotification(
    sharedUserId,
    'project_shared',
    `${ownerName} shared "${projectName}" with you`,
    `You've been added as ${role} on "${projectName}".`,
    `/projects/${projectId}`
  );
  if (shouldEmail(sharedUserId, 'project_shared')) {
    sendProjectSharedEmail(sharedUser.email, ownerName, projectName, role).catch((e) => console.error('[notify] email error:', e.message));
  }
}

export function notifyCommentReply(parentAnnotation, replyBody, replierUserId, textId, textName) {
  // Don't notify if replying to own comment
  if (parentAnnotation.user_id === replierUserId) return;
  const replier = getUserById(replierUserId);
  const parentUser = getUserById(parentAnnotation.user_id);
  if (!replier || !parentUser) return;
  const replierName = replier.display_name || replier.email;
  createNotification(
    parentAnnotation.user_id,
    'comment_reply',
    `${replierName} replied to your comment`,
    replyBody.length > 100 ? replyBody.slice(0, 100) + '...' : replyBody,
    `/texts/${textId}?tab=review&annotations=1`
  );
  if (shouldEmail(parentAnnotation.user_id, 'comment_reply')) {
    sendCommentReplyEmail(parentUser.email, replierName, replyBody, textName || 'a document').catch((e) => console.error('[notify] email error:', e.message));
  }
}

export function notifyMention(mentionedUserIds, commentBody, mentionerUserId, textId, textName) {
  const mentioner = getUserById(mentionerUserId);
  if (!mentioner) return;
  const mentionerName = mentioner.display_name || mentioner.email;
  for (const uid of mentionedUserIds) {
    // Don't notify self
    if (uid === mentionerUserId) continue;
    const user = getUserById(uid);
    if (!user) continue;
    createNotification(
      uid,
      'comment_mention',
      `${mentionerName} mentioned you in a comment`,
      commentBody.length > 100 ? commentBody.slice(0, 100) + '...' : commentBody,
      `/texts/${textId}?tab=review&annotations=1`
    );
    if (shouldEmail(uid, 'comment_mention')) {
      sendMentionEmail(user.email, mentionerName, commentBody, textName || 'a document').catch((e) => console.error('[notify] email error:', e.message));
    }
  }
}
