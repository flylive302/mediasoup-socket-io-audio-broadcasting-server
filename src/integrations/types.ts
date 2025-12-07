export interface GiftTransaction {
  transaction_id: string;
  room_id: string;
  sender_id: number;
  recipient_id: number;
  gift_id: string;
  quantity: number;
  timestamp: number;
  sender_socket_id: string; // Used to notify sender of error, NOT sent to Laravel
}

export interface BatchProcessingResult {
  processed: number;
  failed: Array<{
    transaction_id: string;
    error: string;
    sender_id: number;
    sender_socket_id?: string;
  }>;
}

export interface RoomStatusUpdate {
  is_live: boolean;
  participant_count: number;
  closed_at?: string;
}
