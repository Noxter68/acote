# Booklia Backend

## Seed prod database

Pour déployer un business configuré en local vers la prod, sans tout refaire à la main.

### Prérequis

- Le business est entièrement configuré en local (catégories, prestations, horaires, employés, facturation)
- L'utilisateur (owner) a déjà été créé en prod via l'interface admin

### Step by step

**1. Crée l'utilisateur en prod**

Via l'admin Booklia prod → crée le compte owner → il reçoit l'email de vérification.

Note l'ID du user et du business créé automatiquement (visible dans Neon console ou Railway logs).

**2. Configure le business en local**

Travaille normalement en local : catégories, prestations, horaires, employés, paramètres de facturation.

**3. Génère le SQL**

```bash
cd backend
npx ts-node scripts/export-business-to-prod.ts \
  --businessId <id_business_local> \
  --prodUserId <id_user_prod> \
  --prodBusinessId <id_business_prod> \
  --out scripts/seed-prod-<nom>.sql
```

- `--businessId` : ID du business en local
- `--prodUserId` : ID du user déjà existant en prod
- `--prodBusinessId` : ID du business vide créé par l'admin en prod (optionnel — si absent, fait un INSERT complet)

**4. Applique en prod**

```bash
psql "PROD_DATABASE_URL" -f scripts/seed-prod-<nom>.sql
```

Le script fait un `UPDATE` du business existant + insère toutes les catégories, prestations, horaires, employés et paramètres de facturation.
