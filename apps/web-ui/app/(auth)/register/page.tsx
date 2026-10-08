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

const registerSchema = z
  .object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(1, 'Confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export default function RegisterPage() {
  const router = useRouter();

  const form = useForm({
    defaultValues: { email: '', password: '', confirmPassword: '' },
    onSubmit: async ({ value }) => {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: value.email, password: value.password }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? 'Registration failed');
        return;
      }

      toast.success('Account created!');

      const result = await signIn('credentials', {
        email: value.email,
        password: value.password,
        redirect: false,
      });

      if (result?.error) {
        toast.error('Account created but sign-in failed. Please try logging in.');
      } else {
        router.push('/dashboard');
      }
    },
    validators: {
      onSubmit: ({ value }) => {
        const result = registerSchema.safeParse(value);
        if (!result.success) {
          const fieldErrors = result.error.flatten().fieldErrors;
          return {
            fields: {
              email: fieldErrors.email?.[0],
              password: fieldErrors.password?.[0],
              confirmPassword: fieldErrors.confirmPassword?.[0],
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
              <h1 className="text-base leading-snug font-medium text-xl">Create your account</h1>
              <CardDescription>Enter your details to get started</CardDescription>
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
                      Sign up with Google
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
                  <Field className="grid grid-cols-2 gap-4">
                    <form.Field name="password">
                      {(field) => (
                        <Field
                          data-invalid={field.state.meta.errors.length > 0 ? 'true' : undefined}
                        >
                          <FieldLabel htmlFor={field.name}>Password</FieldLabel>
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
                    <form.Field name="confirmPassword">
                      {(field) => (
                        <Field
                          data-invalid={field.state.meta.errors.length > 0 ? 'true' : undefined}
                        >
                          <FieldLabel htmlFor={field.name}>Confirm</FieldLabel>
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
                  </Field>
                  <FieldDescription>Must be at least 8 characters long.</FieldDescription>
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
                              Creating...
                            </>
                          ) : (
                            'Create account'
                          )}
                        </Button>
                      )}
                    </form.Subscribe>
                    <FieldDescription className="text-center">
                      Already have an account? <Link href="/login">Sign in</Link>
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
