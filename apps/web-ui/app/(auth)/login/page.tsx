'use client';

import { useForm } from '@tanstack/react-form';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { z } from 'zod';
import { GalleryVerticalEnd } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SecretInput } from '@/components/ui/secret-input';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from '@/components/ui/field';

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export default function LoginPage() {
  const router = useRouter();

  const form = useForm({
    defaultValues: { email: '', password: '' },
    onSubmit: async ({ value }) => {
      const result = await signIn('credentials', {
        email: value.email,
        password: value.password,
        redirect: false,
      });

      if (result?.error) {
        toast.error('Invalid email or password');
      } else {
        router.push('/dashboard');
      }
    },
    validators: {
      onSubmit: ({ value }) => {
        const result = loginSchema.safeParse(value);
        if (!result.success) {
          const fieldErrors = result.error.flatten().fieldErrors;
          return {
            fields: {
              email: fieldErrors.email?.[0],
              password: fieldErrors.password?.[0],
            },
          };
        }
        return undefined;
      },
    },
  });

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <span className="flex items-center gap-2 self-center font-medium">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <GalleryVerticalEnd className="size-4" />
          </div>
          AgentFork
        </span>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader className="text-center">
              <h1 className="text-base leading-snug font-medium text-xl">Welcome back</h1>
              <CardDescription>Sign in to your account</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  form.handleSubmit();
                }}
              >
                <FieldGroup>
                  <Field>
                    <Button
                      variant="outline"
                      type="button"
                      className="w-full"
                      onClick={() => signIn('google', { callbackUrl: '/dashboard' })}
                    >
                      Sign in with Google
                    </Button>
                  </Field>
                  <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
                    Or continue with
                  </FieldSeparator>
                  <form.Field name="email">
                    {(field) => (
                      <Field data-invalid={field.state.meta.errors.length > 0 ? 'true' : undefined}>
                        <FieldLabel htmlFor={field.name}>Email</FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          type="email"
                          placeholder="you@company.com"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                          onBlur={field.handleBlur}
                          aria-invalid={!!field.state.meta.errors.length}
                        />
                        <FieldError
                          errors={field.state.meta.errors.map((e) => ({ message: String(e) }))}
                        />
                      </Field>
                    )}
                  </form.Field>
                  <form.Field name="password">
                    {(field) => (
                      <Field data-invalid={field.state.meta.errors.length > 0 ? 'true' : undefined}>
                        <div className="flex items-center">
                          <FieldLabel htmlFor={field.name}>Password</FieldLabel>
                          <Link
                            href="/forgot-password"
                            className="ml-auto text-sm underline-offset-4 hover:underline"
                          >
                            Forgot your password?
                          </Link>
                        </div>
                        <SecretInput
                          id={field.name}
                          name={field.name}
                          placeholder="••••••••"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                          onBlur={field.handleBlur}
                          aria-invalid={!!field.state.meta.errors.length}
                        />
                        <FieldError
                          errors={field.state.meta.errors.map((e) => ({ message: String(e) }))}
                        />
                      </Field>
                    )}
                  </form.Field>
                  <Field>
                    <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
                      {([canSubmit, isSubmitting]) => (
                        <Button
                          type="submit"
                          className="w-full"
                          disabled={!canSubmit || isSubmitting}
                        >
                          {isSubmitting ? (
                            <>
                              <Spinner className="mr-2 size-3" />
                              Signing in...
                            </>
                          ) : (
                            'Sign in'
                          )}
                        </Button>
                      )}
                    </form.Subscribe>
                    <FieldDescription className="text-center">
                      Don&apos;t have an account? <Link href="/register">Create one</Link>
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </form>
            </CardContent>
          </Card>
          <FieldDescription className="px-6 text-center">
            By clicking continue, you agree to our <a href="#">Terms of Service</a> and{' '}
            <a href="#">Privacy Policy</a>.
          </FieldDescription>
        </div>
      </div>
    </div>
  );
}
