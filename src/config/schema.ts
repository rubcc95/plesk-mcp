import { z } from "zod";

export const AuthSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("apiKey"),
    apiKey: z.string().min(1)
  }),
  z.object({
    mode: z.literal("basic"),
    username: z.string().min(1),
    password: z.string().min(1)
  })
]);

export const ServerSchema = z
  .object({
    name: z.string().min(1),
    url: z.url(),
    auth: AuthSchema,
    verifyTls: z.boolean().default(true),
    /** `null` (the default) disables the timeout. */
    timeoutMs: z.number().int().positive().nullable().default(null),
    /** MySQL user with access to all databases on the server. */
    dbUser: z.string().min(1).optional(),
    /** Password for the MySQL user. */
    dbPass: z.string().min(1).optional()
  })
  .refine((server) => (server.dbUser === undefined) === (server.dbPass === undefined), {
    message: "dbUser and dbPass must be provided together",
    path: ["dbUser"]
  });

/** Database reachable directly on the local network. */
export const LocalDatabaseSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive().default(3306),
  user: z.string().min(1),
  password: z.string().min(1),
  ssl: z.boolean().default(false)
});

export const RegistrySchema = z.object({
  defaultServer: z.string().min(1).optional(),
  servers: z.array(ServerSchema).default([]),
  localDatabases: z.array(LocalDatabaseSchema).default([])
});

export type ServerConfig = z.infer<typeof ServerSchema>;
export type LocalDatabaseConfig = z.infer<typeof LocalDatabaseSchema>;
export type RegistryConfig = z.infer<typeof RegistrySchema>;
