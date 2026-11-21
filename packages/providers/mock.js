let mockCount = 0;
export const sendViaMock = async (account, message) => {
  // One log line per 25 sends: at a million recipients, logging every message is itself
  // the bottleneck (and it drowns the console the operators actually read).
  if (process.env.NODE_ENV !== 'test' && (mockCount++ % 25 === 0 || process.env.LOG_EVERY_SEND === 'true')) {
    console.log(`[mock-send] ${account.fromEmail} -> ${message.to}: ${message.subject}`);
  }
  return { providerMessageId: `mock-${message.id}`, accepted: true };
};
