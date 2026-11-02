import { StorageAdapter } from '../storage/StorageAdapter.js';
import { MessageDispatcher } from './MessageDispatcher.js';
import { PersonalityEngine } from '../intelligence/PersonalityEngine.js';
import { ApprovalQueueItem } from '../types/index.js';

export class ApprovalManager {
  constructor(
    private storage: StorageAdapter,
    private dispatcher: MessageDispatcher,
    private personalityEngine: PersonalityEngine
  ) {}

  public async addToQueue(item: Omit<ApprovalQueueItem, 'id' | 'createdAt' | 'status'>): Promise<ApprovalQueueItem> {
    const queueItem: ApprovalQueueItem = {
      ...item,
      id: `appr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
      status: 'pending',
    };

    await this.storage.saveApprovalItem(queueItem);
    return queueItem;
  }

  public async approve(approvalId: string): Promise<{ success: boolean; reason?: string }> {
    const item = await this.storage.getApprovalItem(approvalId);
    if (!item) return { success: false, reason: 'Item de aprovação não encontrado.' };
    if (item.status !== 'pending') return { success: false, reason: `Item já está com status ${item.status}.` };

    const responseText = item.editedResponse || item.suggestedResponse;
    const originalMsg = await this.storage.getMessage(item.messageId);
    const res = await this.dispatcher.dispatch(
      item.messageId,
      item.contactId,
      responseText,
      originalMsg?.raw
    );

    if (res.sent) {
      await this.storage.updateApprovalStatus(approvalId, 'approved');
      this.personalityEngine.learnFromFeedback(item.suggestedResponse, 'approved');
      return { success: true };
    }

    return { success: false, reason: res.reason };
  }

  public async editAndApprove(
    approvalId: string,
    editedText: string
  ): Promise<{ success: boolean; reason?: string }> {
    const item = await this.storage.getApprovalItem(approvalId);
    if (!item) return { success: false, reason: 'Item de aprovação não encontrado.' };
    if (item.status !== 'pending') return { success: false, reason: `Item já está com status ${item.status}.` };

    const originalMsg = await this.storage.getMessage(item.messageId);
    const res = await this.dispatcher.dispatch(
      item.messageId,
      item.contactId,
      editedText,
      originalMsg?.raw
    );
    if (res.sent) {
      await this.storage.updateApprovalStatus(approvalId, 'edited', editedText);
      this.personalityEngine.learnFromFeedback(item.suggestedResponse, 'edited', editedText);
      return { success: true };
    }

    return { success: false, reason: res.reason };
  }

  public async reject(approvalId: string): Promise<{ success: boolean; reason?: string }> {
    const item = await this.storage.getApprovalItem(approvalId);
    if (!item) return { success: false, reason: 'Item de aprovação não encontrado.' };
    if (item.status !== 'pending') return { success: false, reason: `Item já está com status ${item.status}.` };

    await this.storage.updateApprovalStatus(approvalId, 'rejected');
    this.personalityEngine.learnFromFeedback(item.suggestedResponse, 'rejected');
    return { success: true };
  }

  public async getPending(): Promise<ApprovalQueueItem[]> {
    return this.storage.getPendingApprovals();
  }
}
