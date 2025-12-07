export interface AuthenticatedUser {
  id: number;
  name: string;
  email: string;
  avatar_url?: string;
  role?: string;
  [key: string]: unknown;
}

export interface AuthSocketData {
  user: AuthenticatedUser;
  token: string;
}
