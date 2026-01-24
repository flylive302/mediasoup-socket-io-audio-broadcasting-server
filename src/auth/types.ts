/**
 * User data structure
 * Unified type for all user representations in the system
 */
export interface User {
  id: number;
  name: string;
  signature: string;
  email: string;
  avatar: string;
  frame: string;
  gender: string;
  date_of_birth: string; // ISO date string (YYYY-MM-DD)
  phone: string;
  country: string;
  coins: string;
  diamonds: string;
  wealth_xp: string;
  charm_xp: string;
  is_blocked: boolean;
  isSpeaker: boolean;
}

export interface AuthSocketData {
  user: User;
  token: string;
}
