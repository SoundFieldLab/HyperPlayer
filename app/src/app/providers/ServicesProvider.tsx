import { createContext, useContext, type PropsWithChildren } from 'react';
import type { Services } from '../wiring';

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: PropsWithChildren<{ services: Services }>) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('ServicesProvider is missing');
  return services;
}
