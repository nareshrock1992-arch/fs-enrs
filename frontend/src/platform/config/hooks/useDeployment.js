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

  const fetchPreview = useCallback(async (changes) => {
    if (!changes?.length) return;
    setPreviewing(true);
    setError(null);
    setPreview(null);
    try {
      const data = await api.platformConfig.preview(providerId, changes);
      setPreview(data);
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setPreviewing(false);
    }
  }, [providerId]);

  const deploy = useCallback(async (changes, reason) => {
    if (!changes?.length) return null;
    setDeploying(true);
    setError(null);
    setResult(null);
    try {
      const data = await api.platformConfig.deploy(providerId, changes, reason);
      setResult(data);
      return data;
    } catch (err) {
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
  }, []);

  return {
    preview,
    previewing,
    deploying,
    rolling,
    result,
    error,
    fetchPreview,
    deploy,
    rollback,
    clearResult,
  };
}
