import jwt from 'jsonwebtoken';

const JWT_SECRET: string = process.env.JWT_SECRET ?? (() => {
  throw new Error('JWT_SECRET is not set (check backend/.env)');
})();

const EXPIRES_IN = '30d';

export interface AppJwtPayload {
  userId: string;
}

export function signToken(payload: AppJwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: EXPIRES_IN });
}

export function verifyToken(token: string): AppJwtPayload {
  const decoded = jwt.verify(token, JWT_SECRET);
  if (typeof decoded === 'string' || typeof decoded.userId !== 'string') {
    throw new Error('Invalid token payload');
  }
  return { userId: decoded.userId };
}
