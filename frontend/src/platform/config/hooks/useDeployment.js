import { useState, useCallback } from 'react';
import { api } from '../../../api/client.js';

/**
 * useDeployment — encapsulates preview, deploy, and rollback state.
 *
 * @param {string} providerId
 */
export function useDeployment(providerId) {
  const [deploying,  setDeploying]  = useState(false);
  const [rolling,    setRolling]    = useState(false);
  const [preview,    setPreview]    = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [result,     setResult]     = useState(null);
  const [error,      setError]      = useState(null);
  const [isDrift,    setIsDrift]    = useState(false);

  const fetchPreview = useCallback(async (changes, checksum) => {
    if (!changes?.length) return;
    // DEBUG — remove before production
    // eslint-disable-next-line no-console
    console.group('%c[fetchPreview] ops being sent to backend', 'color:#3b82f6;font-weight:bold');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(changes, null, 2));
    // eslint-disable-next-line no-console
    console.groupEnd();
    setPreviewing(true);
    setError(null);
    setPreview(null);
    setIsDrift(false);
    try {
      const data = await api.platformConfig.preview(providerId, changes, checksum);
      setPreview(data);
      return data;
    } catch (err) {
      if (err.status === 409) setIsDrift(true);
      setError(err.message);
      return null;
    } finally {
      setPreviewing(false);
    }
  }, [providerId]);

  const deploy = useCallback(async (changes, reason, checksum) => {
    if (!changes?.length) return null;
    // DEBUG — remove before production
    // eslint-disable-next-line no-console
    console.group('%c[deploy] ops being sent to backend', 'color:#ef4444;font-weight:bold');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(changes, null, 2));
    // eslint-disable-next-line no-console
    console.groupEnd();
    setDeploying(true);
    setError(null);
    setResult(null);
    setIsDrift(false);
    try {
      const data = await api.platformConfig.deploy(providerId, changes, reason, checksum);
      setResult(data);
      return data;
    } catch (err) {
      if (err.status === 409) setIsDrift(true);
      setError(err.message);
      return null;
    } finally {
      setDeploying(false);
    }
  }, [providerId]);

  const rollback = useCallback(async (versionId, reason) => {
    setRolling(true);
    setError(null);
    try {
      const data = await api.platformConfig.rollback(providerId, versionId, reason);
      setResult(data);
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setRolling(false);
    }
  }, [providerId]);

  const clearResult = useCallback(() => {
    setResult(null);
    setPreview(null);
    setError(null);
    setIsDrift(false);
  }, []);

  return {
    preview,
    previewing,
    deploying,
    rolling,
    result,
    error,
    isDrift,
    fetchPreview,
    deploy,
    rollback,
    clearResult,
  };
}
