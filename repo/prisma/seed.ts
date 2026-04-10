import { PrismaClient } from '../src/models/prisma';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const ADMIN_PERMISSIONS = [
  'user:read', 'user:write', 'user:delete',
  'role:read', 'role:write',
  'permission:read', 'permission:write',
  'itinerary:read', 'itinerary:write', 'itinerary:delete',
  'resource:read', 'resource:write', 'resource:delete',
  'import:read', 'import:write',
  'model:read', 'model:write',
  'notification:read', 'notification:write',
  'audit:read', 'audit:export',
];

// The organizer baseline gives a self-service planner the minimum permission
// points needed to: plan and edit itineraries, browse the resource catalog,
// upload data via the import flow, run model inferences, and read their own
// notifications. The set is intentionally narrower than admin (no `:delete`,
// no `:write` on resources/models, no audit access).
const ORGANIZER_PERMISSIONS = [
  'itinerary:read', 'itinerary:write',
  'resource:read',
  'import:read', 'import:write',
  'model:read',
  'notification:read',
];

async function main() {
  // Create permission points
  for (const code of [...new Set([...ADMIN_PERMISSIONS, ...ORGANIZER_PERMISSIONS])]) {
    await prisma.permissionPoint.upsert({
      where: { code },
      update: {},
      create: { code, description: `Permission: ${code}` },
    });
  }
  console.log(`Seeded ${ADMIN_PERMISSIONS.length} permission points`);

  // Create admin role
  const adminRole = await prisma.role.upsert({
    where: { name: 'admin' },
    update: {},
    create: { name: 'admin', description: 'Full system access' },
  });

  // Assign all permissions to admin
  const allPoints = await prisma.permissionPoint.findMany({
    where: { code: { in: ADMIN_PERMISSIONS } },
  });
  await prisma.rolePermissionPoint.deleteMany({ where: { roleId: adminRole.id } });
  await prisma.rolePermissionPoint.createMany({
    data: allPoints.map((pp) => ({ roleId: adminRole.id, permissionPointId: pp.id })),
  });

  // Create organizer role
  const organizerRole = await prisma.role.upsert({
    where: { name: 'organizer' },
    update: {},
    create: { name: 'organizer', description: 'Itinerary owner access' },
  });

  // Assign organizer permissions
  const orgPoints = await prisma.permissionPoint.findMany({
    where: { code: { in: ORGANIZER_PERMISSIONS } },
  });
  await prisma.rolePermissionPoint.deleteMany({ where: { roleId: organizerRole.id } });
  await prisma.rolePermissionPoint.createMany({
    data: orgPoints.map((pp) => ({ roleId: organizerRole.id, permissionPointId: pp.id })),
  });

  // Create admin user
  const adminPassword = await bcrypt.hash('Admin123!Admin', 12);
  const adminUser = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      passwordHash: adminPassword,
      role: 'admin',
      status: 'active',
    },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: adminUser.id, roleId: adminRole.id } },
    update: {},
    create: { userId: adminUser.id, roleId: adminRole.id },
  });
  await prisma.passwordHistory.upsert({
    where: { id: `seed-admin-ph` },
    update: {},
    create: { id: 'seed-admin-ph', userId: adminUser.id, passwordHash: adminPassword },
  });

  // Create organizer user
  const orgPassword = await bcrypt.hash('Organizer123!', 12);
  const orgUser = await prisma.user.upsert({
    where: { username: 'organizer' },
    update: {},
    create: {
      username: 'organizer',
      passwordHash: orgPassword,
      role: 'organizer',
      status: 'active',
    },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: orgUser.id, roleId: organizerRole.id } },
    update: {},
    create: { userId: orgUser.id, roleId: organizerRole.id },
  });
  await prisma.passwordHistory.upsert({
    where: { id: `seed-org-ph` },
    update: {},
    create: { id: 'seed-org-ph', userId: orgUser.id, passwordHash: orgPassword },
  });

  console.log('Seeded admin user (admin / Admin123!Admin)');
  console.log('Seeded organizer user (organizer / Organizer123!)');
  console.log('Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
