# Docker Compose for ShareCode Development

This Docker Compose file sets up a local PostgreSQL database for ShareCode development.

## Quick Start

```bash
# Start the database
docker compose -f docker-compose.dev.yml up -d

# Stop the database
docker compose -f docker-compose.dev.yml down

# View logs
docker compose -f docker-compose.dev.yml logs -f

# Reset database (removes all data)
docker compose -f docker-compose.dev.yml down -v
rm -rf data/postgres data/pgadmin
```

## Services

### PostgreSQL Database
- **Port**: 5432
- **Database**: sharecode
- **Username**: sharecode
- **Password**: sharecode_dev_password
- **Data**: Stored in `./data/postgres`

### pgAdmin (Optional)
- **Port**: 5050
- **URL**: http://localhost:5050
- **Email**: admin@example.com
- **Password**: admin
- **Data**: Stored in `./data/pgadmin`

## Connection String

For your backend `.env` file:

```env
DATABASE_URL=postgresql://sharecode:sharecode_dev_password@localhost:5432/sharecode
```

## Database Management

### Using psql (PostgreSQL CLI)

```bash
# Connect to database
docker compose -f docker-compose.dev.yml exec postgres psql -U sharecode -d sharecode

# Run SQL commands
docker compose -f docker-compose.dev.yml exec postgres psql -U sharecode -d sharecode -c "SELECT version();"

# Backup database
docker compose -f docker-compose.dev.yml exec postgres pg_dump -U sharecode sharecode > backup.sql

# Restore database
docker compose -f docker-compose.dev.yml exec -T postgres psql -U sharecode sharecode < backup.sql
```

### Using pgAdmin

1. Open http://localhost:5050
2. Login with `admin@example.com` / `admin`
3. Add server:
   - **Name**: ShareCode Local
   - **Host**: postgres (or host.docker.internal on macOS)
   - **Port**: 5432
   - **Username**: sharecode
   - **Password**: sharecode_dev_password

## Data Persistence

All database data is stored in the `./data` directory:
- `./data/postgres` - PostgreSQL data files
- `./data/pgadmin` - pgAdmin configuration

**Important**: The `data/` directory is git-ignored to prevent committing database files.

## Troubleshooting

### Port Already in Use

If port 5432 is already in use, edit `docker-compose.dev.yml` and change:
```yaml
ports:
  - "5433:5432"  # Use 5433 on host instead
```

Then update your connection string:
```env
DATABASE_URL=postgresql://sharecode:sharecode_dev_password@localhost:5433/sharecode
```

### Permission Errors

If you encounter permission errors with the data directory:
```bash
# Fix permissions
sudo chown -R $USER:$USER data/
```

### Reset Everything

To completely reset the database:
```bash
docker compose -f docker-compose.dev.yml down -v
rm -rf data/postgres data/pgadmin
docker compose -f docker-compose.dev.yml up -d
```

## Production Notes

⚠️ **This is for development only!**

For production:
- Use strong passwords
- Don't expose pgAdmin
- Use environment variables for secrets
- Consider managed database services
- Enable SSL/TLS
- Set up proper backups
