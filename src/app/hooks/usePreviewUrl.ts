import { useQuery } from '@tanstack/react-query';
import {
  buildPublicUrl,
  generateSignedUrl,
  hasSigningCredentials,
  isBucketPublic,
  StorageConfig,
} from '@/app/lib/r2cache';

/**
 * Signed URLs are minted for an hour but treated as fresh for 45 minutes, so
 * every URL handed to an <img> keeps at least 15 minutes of validity while
 * repeated scrolling through the grid reuses the same URL — and with it the
 * browser's image cache (a re-signed URL differs in its query string and
 * would force a full refetch of every thumbnail).
 */
const SIGNED_URL_EXPIRES_IN_S = 60 * 60;
const SIGNED_URL_FRESH_MS = 45 * 60 * 1000;

/**
 * URL for displaying an object's content inline (grid thumbnails, previews).
 *
 * Public buckets serve the provider's public URL directly; private buckets
 * fall back to a temporary signed URL when credentials allow — the same
 * public-vs-signed decision the preview modal makes. Returns null while
 * signing is in flight or when neither path is available (the caller keeps
 * showing its icon fallback).
 */
export function usePreviewUrl(
  config: StorageConfig | null | undefined,
  key: string,
  enabled: boolean
): string | null {
  const isPublic = isBucketPublic(config);
  const canSign = !isPublic && hasSigningCredentials(config);
  const { data: signedUrl } = useQuery({
    queryKey: ['preview-url', config?.provider, config?.accountId, config?.bucket, key],
    queryFn: () => generateSignedUrl(config!, key, SIGNED_URL_EXPIRES_IN_S),
    enabled: enabled && !!config && canSign,
    staleTime: SIGNED_URL_FRESH_MS,
    gcTime: SIGNED_URL_FRESH_MS,
    retry: 1,
  });

  if (!enabled || !config) return null;
  if (isPublic) return buildPublicUrl(config, key);
  return signedUrl ?? null;
}
