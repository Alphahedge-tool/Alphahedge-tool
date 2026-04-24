import { proxyToBackend } from './_utils/proxy';

interface Env {
  BACKEND_ORIGIN?: string;
}

export const onRequest = ({ request, env }: { request: Request; env: Env }) => {
  return proxyToBackend(request, env);
};
