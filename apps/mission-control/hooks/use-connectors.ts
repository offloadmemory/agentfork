import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BASE_PATH } from '@/lib/base-path';

export type ChannelId = 'slack' | 'telegram' | 'discord';

export interface HilCapabilities {
  clarification: boolean;
  approvalButtons: boolean;
  threadedReplies: boolean;
}

export interface ConnectorSummary {
  channel: ChannelId;
  displayName: string;
  description: string;
  deliveryMode: 'streaming' | 'callback' | 'polling';
  hilCapabilities: HilCapabilities;
  configured: boolean;
  enabled: boolean;
}

export interface ConnectorDetail {
  channel: ChannelId;
  configured: boolean;
  enabled: boolean;
  /** Secret values arrive already masked; non-secret values are verbatim. */
  fields: Record<string, string>;
  displayName: string;
  description: string;
  deliveryMode: 'streaming' | 'callback' | 'polling';
  hilCapabilities: HilCapabilities;
  /** Gateway endpoint to register with the platform. */
  webhookUrl?: string;
}

export interface ConnectorSaveResult {
  data: ConnectorDetail;
  /** Set when credentials saved but inbound routing could not be established. */
  warning?: string;
}

export interface ConnectorTestResult {
  detail: string;
  [key: string]: string;
}

async function unwrap<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error ?? fallback);
  }
  return data as T;
}

async function fetchConnectors(): Promise<ConnectorSummary[]> {
  const res = await fetch(`${BASE_PATH}/api/connectors`);
  const data = await unwrap<{ connectors: ConnectorSummary[] }>(res, 'Failed to load connectors');
  return data.connectors;
}

async function fetchConnector(channel: ChannelId): Promise<ConnectorDetail> {
  const res = await fetch(`${BASE_PATH}/api/connectors/${channel}`);
  const data = await unwrap<{ data: ConnectorDetail }>(res, 'Failed to load connector');
  return data.data;
}

async function saveConnector(
  channel: ChannelId,
  input: Record<string, string | boolean | string[] | undefined>,
): Promise<ConnectorSaveResult> {
  const res = await fetch(`${BASE_PATH}/api/connectors/${channel}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return unwrap<ConnectorSaveResult>(res, 'Failed to save connector');
}

async function resetConnector(channel: ChannelId): Promise<void> {
  const res = await fetch(`${BASE_PATH}/api/connectors/${channel}`, { method: 'DELETE' });
  await unwrap(res, 'Failed to reset connector');
}

async function testConnector(
  channel: ChannelId,
  overrides: Record<string, string>,
): Promise<ConnectorTestResult> {
  const res = await fetch(`${BASE_PATH}/api/connectors/${channel}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overrides),
  });
  const data = await unwrap<{ data: ConnectorTestResult }>(res, 'Connection test failed');
  return data.data;
}

export const connectorKeys = {
  all: ['connectors'] as const,
  lists: () => [...connectorKeys.all, 'list'] as const,
  details: () => [...connectorKeys.all, 'detail'] as const,
  detail: (channel: ChannelId) => [...connectorKeys.details(), channel] as const,
};

export function useConnectors() {
  return useQuery({ queryKey: connectorKeys.lists(), queryFn: fetchConnectors });
}

export function useConnector(channel: ChannelId) {
  return useQuery({
    queryKey: connectorKeys.detail(channel),
    queryFn: () => fetchConnector(channel),
    enabled: Boolean(channel),
  });
}

export function useSaveConnector(channel: ChannelId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, string | boolean | string[] | undefined>) => saveConnector(channel, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: connectorKeys.detail(channel) });
      queryClient.invalidateQueries({ queryKey: connectorKeys.lists() });
    },
  });
}

export function useResetConnector(channel: ChannelId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => resetConnector(channel),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: connectorKeys.detail(channel) });
      queryClient.invalidateQueries({ queryKey: connectorKeys.lists() });
    },
  });
}

export function useTestConnector(channel: ChannelId) {
  return useMutation({ mutationFn: (overrides: Record<string, string>) => testConnector(channel, overrides) });
}
