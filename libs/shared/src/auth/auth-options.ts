import './auth-types';
import { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { getPrismaClient } from '../db/prisma-client';
import { createLogger } from '../logging/logger';
import { AuditService } from '../services/audit-service';
import { TenantConfigService } from '../services/tenant-config-service';
import { env } from '../env';

const logger = createLogger('auth-options');

export function createAuthOptions(overrides?: Partial<NextAuthOptions>): NextAuthOptions {
  const prisma = getPrismaClient();

  const prismaForAuth = {
    user: prisma.authUser,
    account: prisma.authAccount,
    session: prisma.authSession,
    verificationToken: prisma.verificationToken,
  };

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter: PrismaAdapter(prismaForAuth as any) as any,
    session: { strategy: 'jwt', maxAge: 24 * 60 * 60 },
    secret: env.NEXTAUTH_SECRET,
    providers: [
      CredentialsProvider({
        id: 'credentials',
        name: 'Credentials',
        credentials: {
          email: { label: 'Email', type: 'email' },
          password: { label: 'Password', type: 'password' },
        },
        async authorize(credentials) {
          if (!credentials?.email || !credentials?.password) return null;

          const email = credentials.email as string;
          const password = credentials.password as string;

          const user = await prisma.authUser.findUnique({ where: { email } });

          if (!user) return null;

          if (!user.passwordHash) {
            throw new Error('This account uses SSO. Please sign in with the SSO tab.');
          }

          // Account lockout check
          if (user.lockedUntil && user.lockedUntil > new Date()) {
            const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / (60 * 1000));
            throw new Error(
              `Account locked. Try again in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}.`
            );
          }

          const bcrypt = await import('bcryptjs');
          const passwordValid = await bcrypt.compare(password, user.passwordHash);

          if (!passwordValid) {
            const newFailedAttempts = user.failedAttempts + 1;
            const lockedUntil =
              newFailedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;

            await prisma.authUser.update({
              where: { id: user.id },
              data: {
                failedAttempts: newFailedAttempts,
                ...(lockedUntil ? { lockedUntil } : {}),
              },
            });

            AuditService.createAuditLog({
              tenantId: 'global',
              eventType: 'auth.session.login_failed',
              action: 'Failed Login Attempt',
              user: email,
              userType: 'user',
              status: 'error',
              severity: newFailedAttempts >= 5 ? 'critical' : 'high',
              details: `Failed login attempt ${newFailedAttempts} for ${email}` +
                (lockedUntil ? ` — account locked for 15 minutes` : ''),
              source: 'platform',
              resource: email,
              metadata: { email, failedAttempts: newFailedAttempts, locked: !!lockedUntil },
            }).catch(() => { });

            return null;
          }

          // Successful login — reset lockout state
          await prisma.authUser.update({
            where: { id: user.id },
            data: { failedAttempts: 0, lockedUntil: null },
          });

          AuditService.createAuditLog({
            tenantId: 'global',
            eventType: 'auth.session.login',
            action: 'User Login',
            user: user.email ?? user.id,
            userType: 'user',
            status: 'success',
            severity: 'low',
            details: `User ${user.email} logged in via credentials`,
            source: 'platform',
            resource: user.email ?? user.id,
            metadata: { provider: 'credentials', userId: user.id },
          }).catch(() => { });

          return {
            id: user.id,
            email: user.email,
            isSuperAdmin: user.isSuperAdmin,
            failedAttempts: 0,
            lockedUntil: null,
          };
        },
      }),
      ...(env.GOOGLE_CLIENT_ID
        ? [
          GoogleProvider({
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
            allowDangerousEmailAccountLinking: true,
          }),
        ]
        : []),
    ],
    pages: { signIn: '/login', error: '/login' },
    callbacks: {
      async jwt({ token, user, trigger }) {
        if (user || trigger === 'update') {
          const userId = user?.id ?? (token.sub as string);

          let activeTenantId = (user as any)?.activeTenantId ?? null;
          if (!activeTenantId && trigger === 'update') {
            const dbUser = await prisma.authUser.findUnique({
              where: { id: userId },
              select: { activeTenantId: true },
            });
            activeTenantId = dbUser?.activeTenantId ?? null;
          }

          let utr;
          if (activeTenantId) {
            utr = await prisma.userTenantRole.findFirst({
              where: { userId, tenantId: activeTenantId },
            });
          }
          if (!utr) {
            utr = await prisma.userTenantRole.findFirst({
              where: { userId },
              orderBy: { assignedAt: 'desc' },
            });
          }

          // Accept pending invitations on first login with no tenant
          if (!utr && user) {
            try {
              const { InvitationService } = await import('../services/invitation-service');
              await InvitationService.acceptPendingInvitation(userId, user.email ?? '');
              utr = await prisma.userTenantRole.findFirst({
                where: { userId },
              });
            } catch (err) {
              logger.error({ err }, 'jwt callback: acceptPendingInvitation failed');
            }
          }

          token.tenantId = utr?.tenantId ?? null;
          token.role = utr?.role ?? null;
          if (user) {
            token.isSuperAdmin = (user as any).isSuperAdmin ?? false;
            token.email = user.email;
          }

          const tenantId = token.tenantId as string | null;
          if (tenantId) {
            const configService = new TenantConfigService(tenantId);
            const timezone = await configService.get<string>('timezone');
            token.timezone = timezone ?? 'UTC';
          } else {
            token.timezone = 'UTC';
          }
        }
        return token;
      },
      async session({ session, token }) {
        if (session.user) {
          session.user.id = token.sub!;
          session.user.email = (token.email as string) ?? '';
          session.user.tenantId = (token.tenantId as string | null) ?? null;
          session.user.role = (token.role as string | null) ?? null;
          session.user.isSuperAdmin = (token.isSuperAdmin as boolean) ?? false;
          session.user.timezone = (token.timezone as string) ?? 'UTC';
        }
        return session;
      },
      async redirect({ url, baseUrl }) {
        if (url.startsWith('/')) return `${baseUrl}${url}`;
        if (new URL(url).origin === baseUrl) return url;
        return baseUrl;
      },
    },
    events: {
      async signIn({ user, account }) {
        const utr = await prisma.userTenantRole.findFirst({ where: { userId: user.id } });
        AuditService.createAuditLog({
          tenantId: utr?.tenantId ?? 'global',
          eventType: 'auth.session.login',
          action: 'User Login',
          user: user.email ?? user.id,
          userType: 'user',
          status: 'success',
          severity: 'low',
          details: `User ${user.email} logged in via ${account?.provider ?? 'credentials'}`,
          source: 'platform',
          resource: user.email ?? user.id,
          metadata: { provider: account?.provider ?? 'credentials', userId: user.id },
        }).catch(() => { });
      },
      async signOut({ token }) {
        const userId = token?.sub as string | undefined;
        const email = token?.email as string | undefined;
        const tenantId = token?.tenantId as string | undefined;
        AuditService.createAuditLog({
          tenantId: tenantId ?? 'global',
          eventType: 'auth.session.logout',
          action: 'User Logout',
          user: email ?? userId ?? 'unknown',
          userType: 'user',
          status: 'success',
          severity: 'low',
          details: `User ${email ?? userId} logged out`,
          source: 'platform',
          resource: email ?? userId ?? 'unknown',
          metadata: { userId },
        }).catch(() => { });
      },
    },
    ...overrides,
  };
}

let _authOptions: NextAuthOptions | undefined;
export function getAuthOptions(): NextAuthOptions {
  if (!_authOptions) {
    _authOptions = createAuthOptions();
  }
  return _authOptions;
}
