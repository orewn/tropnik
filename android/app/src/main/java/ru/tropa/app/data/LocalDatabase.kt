package ru.tropa.app.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "saved_routes")
data class SavedRouteEntity(
    @PrimaryKey val routeId: String,
    val title: String,
    val regionId: String,
    val snapshotJson: String,
    val savedAt: Long,
)

@Entity(tableName = "installed_packs")
data class InstalledPackEntity(
    @PrimaryKey val regionId: String,
    val title: String,
    val version: String,
    val directory: String,
    val sizeBytes: Long,
    val installedAt: Long,
    val includesTrailGeometry: Boolean,
)

@Entity(tableName = "local_preferences")
data class PreferenceEntity(@PrimaryKey val key: String, val value: String)

@Entity(tableName = "conversation_cache", primaryKeys = ["origin", "ownerId", "kind", "conversationId"])
data class ConversationCacheEntity(val origin: String, val ownerId: String, val kind: String,
    val conversationId: String, val encryptedJson: String, val updatedAt: Long)

@Entity(tableName = "message_outbox")
data class PendingMessageEntity(@PrimaryKey val clientId: String, val origin: String, val ownerId: String,
    val kind: String, val conversationId: String, val encryptedBody: String, val createdAt: Long,
    val failed: Boolean = false, val error: String? = null)

@Dao
interface LocalDao {
    @Query("SELECT * FROM saved_routes ORDER BY savedAt DESC")
    fun observeSavedRoutes(): Flow<List<SavedRouteEntity>>
    @Query("SELECT * FROM saved_routes WHERE routeId = :id LIMIT 1")
    suspend fun savedRoute(id: String): SavedRouteEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putSavedRoute(route: SavedRouteEntity)
    @Query("DELETE FROM saved_routes WHERE routeId = :id")
    suspend fun removeSavedRoute(id: String)

    @Query("SELECT * FROM installed_packs ORDER BY installedAt DESC")
    fun observePacks(): Flow<List<InstalledPackEntity>>
    @Query("SELECT * FROM installed_packs WHERE regionId = :id LIMIT 1")
    suspend fun pack(id: String): InstalledPackEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putPack(pack: InstalledPackEntity)
    @Query("DELETE FROM installed_packs WHERE regionId = :id")
    suspend fun removePack(id: String)

    @Query("SELECT value FROM local_preferences WHERE `key` = :key LIMIT 1")
    fun observePreference(key: String): Flow<String?>
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putPreference(preference: PreferenceEntity)

    @Query("SELECT * FROM conversation_cache WHERE origin = :origin AND ownerId = :owner AND kind = :kind AND conversationId = :conversation LIMIT 1")
    suspend fun conversation(origin: String, owner: String, kind: String, conversation: String): ConversationCacheEntity?
    @Query("SELECT * FROM conversation_cache WHERE origin = :origin AND ownerId = :owner ORDER BY updatedAt DESC")
    suspend fun conversations(origin: String, owner: String): List<ConversationCacheEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putConversation(row: ConversationCacheEntity)
    @Query("SELECT * FROM message_outbox WHERE origin = :origin AND ownerId = :owner ORDER BY createdAt ASC")
    suspend fun pending(origin: String, owner: String): List<PendingMessageEntity>
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun enqueue(row: PendingMessageEntity)
    @Query("DELETE FROM message_outbox WHERE clientId = :id")
    suspend fun removePending(id: String)
    @Query("UPDATE message_outbox SET failed = :failed, error = :error WHERE clientId = :id")
    suspend fun pendingFailure(id: String, failed: Boolean, error: String?)
    @Query("DELETE FROM conversation_cache WHERE origin = :origin AND ownerId = :owner")
    suspend fun clearConversations(origin: String, owner: String)
    @Query("DELETE FROM message_outbox WHERE origin = :origin AND ownerId = :owner")
    suspend fun clearOutbox(origin: String, owner: String)
}

@Database(entities = [SavedRouteEntity::class, InstalledPackEntity::class, PreferenceEntity::class,
    ConversationCacheEntity::class, PendingMessageEntity::class], version = 2, exportSchema = true)
abstract class LocalDatabase : RoomDatabase() {
    abstract fun dao(): LocalDao

    companion object {
        fun open(context: Context) = Room.databaseBuilder(
            context.applicationContext, LocalDatabase::class.java, "tropa-local.db"
        ).addMigrations(object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS conversation_cache (origin TEXT NOT NULL, ownerId TEXT NOT NULL, kind TEXT NOT NULL, conversationId TEXT NOT NULL, encryptedJson TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(origin, ownerId, kind, conversationId))")
                db.execSQL("CREATE TABLE IF NOT EXISTS message_outbox (clientId TEXT NOT NULL PRIMARY KEY, origin TEXT NOT NULL, ownerId TEXT NOT NULL, kind TEXT NOT NULL, conversationId TEXT NOT NULL, encryptedBody TEXT NOT NULL, createdAt INTEGER NOT NULL, failed INTEGER NOT NULL, error TEXT)")
            }
        }).build()
    }
}
