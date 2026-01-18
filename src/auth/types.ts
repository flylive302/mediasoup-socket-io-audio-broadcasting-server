/**
 * User economy data structure (decimal strings for precision)
 * Per MSAB_PROTOCOL_REFERENCE.md Section 1
 */
export interface UserEconomy {
  coins: string;
  diamonds: string;
  wealth_xp: string;
  charm_xp: string;
}

/**
 * Authenticated user data returned from Laravel backend
 * Per MSAB_PROTOCOL_REFERENCE.md Section 1
 */
export interface AuthenticatedUser {
  id: number;
  name: string;
  signature: string;
  email: string | null;
  avatar: string; // Renamed from avatar_url per protocol
  gender: string;
  date_of_birth: string; // ISO date string (YYYY-MM-DD)
  phone: string;
  country: string;
  economy: UserEconomy; // Nested economy object per protocol
  is_blocked: boolean; // New field per protocol
  [key: string]: unknown; // Allow additional fields for extensibility
}

export interface AuthSocketData {
  user: AuthenticatedUser;
  token: string;
}
