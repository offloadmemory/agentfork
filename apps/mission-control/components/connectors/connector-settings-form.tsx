'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, CheckCircle2, Loader2, PlugZap, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useConnector,
  useSaveConnector,
  useResetConnector,
  useTestConnector,
  type ChannelId,
} from '@/hooks/use-connectors';
import { CHANNEL_FIELDS } from './channel-fields';
import { CHANNEL_VISUALS } from './channel-visuals';
import { ConnectorSecretField } from './connector-secret-field';
import { ConnectorResetCard } from './connector-reset-card';
import { ConnectorWebhookCard } from './connector-webhook-card';

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function ConnectorSettingsForm({ channel }: { channel: ChannelId }) {
  const spec = CHANNEL_FIELDS[channel];
  const visual = CHANNEL_VISUALS[channel];
  const { data: detail, isLoading } = useConnector(channel);

  const save = useSaveConnector(channel);
  const reset = useResetConnector(channel);
  const test = useTestConnector(channel);

  // Inputs stay empty on load: a blank field means "keep the stored value", and
  // the stored secret is only ever available masked.
  const [values, setValues] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = detail?.configured ?? false;
  // Someone entering credentials for the first time means to use them, so a
  // fresh connector defaults to on — otherwise the first save lands on
  // "Deactivated" and needs a second toggle-and-save to actually take effect.
  const effectiveEnabled = enabled ?? (configured ? detail!.enabled : true);
  const setValue = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));

  const visibleFields = spec.fields.filter((field) => {
    if (!field.showWhileEmpty) return true;
    const sibling = field.showWhileEmpty;
    return !values[sibling] && !detail?.fields[sibling];
  });

  const missingRequired = spec.fields.filter(
    (f) => f.required && !values[f.name]?.trim() && !detail?.fields[f.name],
  );

  const handleSave = async () => {
    setError(null);
    try {
      // The API stores an actual string[]; empty input explicitly clears the list.
      const approverIds = values.approverIds === undefined
        ? {}
        : { approverIds: Array.from(new Set(values.approverIds.split(/[,;\n]+/).map((id) => id.trim()).filter(Boolean))) };
      const result = await save.mutateAsync({ ...values, ...approverIds, enabled: effectiveEnabled });
      // Clear the inputs so the form goes back to showing masks — leaving the
      // typed plaintext on screen after a successful save is needless exposure.
      setValues({});
      setEnabled(null);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 3000);
      // The credentials saved, but inbound routing may not have been established
      // (e.g. Slack unreachable). Saying only "saved" would imply the channel is
      // live when it isn't.
      if (result.warning) {
        toast.warning('Saved, with a problem', { description: result.warning });
        setError(result.warning);
      } else {
        toast.success(`${detail?.displayName ?? channel} settings saved`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to save';
      setError(message);
      toast.error('Save failed', { description: message });
    }
  };

  const handleTest = async () => {
    setError(null);
    const overrides: Record<string, string> = {};
    for (const key of spec.testOverrideKeys) {
      const typed = values[key]?.trim();
      if (typed) overrides[key] = typed;
    }
    try {
      const result = await test.mutateAsync(overrides);
      toast.success('Connection verified', { description: result.detail });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Connection test failed';
      toast.error('Connection failed', { description: message });
    }
  };

  const handleReset = async () => {
    try {
      await reset.mutateAsync();
      setValues({});
      setEnabled(null);
      toast.success(`${detail?.displayName ?? channel} connector reset`);
    } catch (e) {
      toast.error('Reset failed', { description: e instanceof Error ? e.message : undefined });
    }
  };

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  const Icon = visual.icon;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Button variant="ghost" size="sm" className="-ml-2" nativeButton={false} render={<Link href="/connectors" />}>
        <ArrowLeft className="mr-1 h-4 w-4" /> Back to connectors
      </Button>

      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${visual.iconBg} ${visual.iconColor}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{detail?.displayName ?? channel}</h1>
            {configured ? (
              <Badge variant="secondary" className="gap-1 text-green-600 dark:text-green-500">
                <CheckCircle2 className="h-3 w-3" /> Configured
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">{detail?.description}</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Credentials</CardTitle>
          <CardDescription>
            {configured
              ? 'Enter new values to update the stored credentials. Leave a field blank to keep its existing value.'
              : `Enter your ${detail?.displayName ?? channel} credentials. They are encrypted before being stored.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {visibleFields.map((field) =>
            field.secret ? (
              <div key={field.name} className="space-y-1.5">
                <ConnectorSecretField
                  id={`${channel}-${field.name}`}
                  label={field.label}
                  value={values[field.name] ?? ''}
                  onChange={(v) => setValue(field.name, v)}
                  maskedValue={detail?.fields[field.name]}
                  placeholder={field.placeholder}
                  hint={field.hint}
                  required={field.required}
                />
                {field.generate ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setValue(field.name, randomHex(32));
                      toast.success(`${field.label} generated`, { description: 'Remember to save.' });
                    }}
                  >
                    <RefreshCw className="mr-1 h-3 w-3" /> Generate
                  </Button>
                ) : null}
              </div>
            ) : (
              <div key={field.name} className="grid gap-1.5">
                <Label htmlFor={`${channel}-${field.name}`}>{field.label}</Label>
                <Input
                  id={`${channel}-${field.name}`}
                  value={values[field.name] ?? detail?.fields[field.name] ?? ''}
                  onChange={(e) => setValue(field.name, e.target.value)}
                  placeholder={field.placeholder}
                />
                {field.hint ? <p className="text-xs text-muted-foreground">{field.hint}</p> : null}
              </div>
            ),
          )}

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <Label htmlFor={`${channel}-enabled`}>Enabled</Label>
              <p className="text-xs text-muted-foreground">
                Turn off to keep the credentials but stop Claw using this connector.
              </p>
            </div>
            <Switch
              id={`${channel}-enabled`}
              checked={effectiveEnabled}
              onCheckedChange={(v) => setEnabled(v)}
            />
          </div>

          {missingRequired.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Required before saving: {missingRequired.map((f) => f.label).join(', ')}.
            </p>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleSave} disabled={save.isPending || missingRequired.length > 0}>
              {save.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : justSaved ? (
                <Check className="mr-2 h-4 w-4" />
              ) : null}
              {justSaved ? 'Saved' : 'Save'}
            </Button>
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={test.isPending || (!configured && !spec.testOverrideKeys.some((k) => values[k]?.trim()))}
            >
              {test.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <PlugZap className="mr-2 h-4 w-4" />
              )}
              Test Connection
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{spec.setupHint}</p>
        </CardContent>
      </Card>

      {detail?.webhookUrl ? (
        <ConnectorWebhookCard channel={channel} webhookUrl={detail.webhookUrl} ready={configured} />
      ) : null}

      <ConnectorResetCard
        displayName={detail?.displayName ?? channel}
        clears={spec.clears}
        disabled={!configured}
        pending={reset.isPending}
        onReset={handleReset}
      />
    </div>
  );
}
