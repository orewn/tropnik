package store

import (
 "bytes"
 "encoding/hex"
 "encoding/json"
 "testing"
 "time"
 "tropa/backend/internal/auth"
)

// This independently generated vector is also preserved byte-for-byte by the
// real encrypted PostgreSQL dump/restore drill. All data and keys are synthetic.
func TestRecoveryMailCiphertextVectorCanBeOpenedByTheApplication(t *testing.T) {
 cipher,err:=auth.NewAccountMailCipher(bytes.Repeat([]byte{0x33},32))
 if err!=nil { t.Fatal(err) }
 raw,err:=hex.DecodeString("d792b279329daec1b9336cb7cd598aeafc8c2ffa8cb3a785f46df012990a8d8964b6aa6b91dc6b2cfce6f6e2f204adaea3ffdb0dd01d67febbaa8b6a403fa7966a48def3e5b61d16ef64c9386461083e70788e8b0ad6e59731dbc5d3783f71eed4caa60e246af5d6cb976adfcefbc97083aa5862f633ac41b0ccb586a032c0236618775a5ff76abac53ba379320155112d1643242f934b88a3b27b095516861c5ce71f6c86a9396a9e583e0a8c575853b2e8fe81971a46cacfba5178d3a62d6cbd12e4580a617f2a071fe363ab31bfe28da6afe8da9fe74dfbbd8248c74115da43e3757af55ddc4cf9cc8d2d0b487920030d8d3d1ac0fe39b69442922f4b4789c02e8f522fceaf794ee9d7da461e7398dc32b4f103bbb0e2ec66de3d7874f4e11674841a3bb652f9b309a79def700c65fa4c80778a9f046ba547f2fe2bf38c915c75598364a6529da7cb99f5305b60e29ae37ff8febff45b010ba086a696d9dd26ec04dee28999cfc0fdae89a6697a512d0e8e149d7405d7524daa654f8dbd3d66eda1f0d0e5ba1b0573b5ec1db746")
 if err!=nil { t.Fatal(err) }
 deadline:=time.Date(2026,1,1,0,30,0,0,time.UTC)
 plain,err:=cipher.Open("00000000-0000-4000-8000-000000000050","reset_password",deadline,raw,bytes.Repeat([]byte{0x44},12))
 if err!=nil { t.Fatal("restored mail vector cannot be decrypted",err) }
 var envelope accountMailEnvelope
 if err=json.Unmarshal(plain,&envelope);err!=nil { t.Fatal(err) }
 if envelope.Recipient!="tourist@backup.invalid" || envelope.Message==nil || envelope.Message.MessageID!="<tropnik-account-00000000-0000-4000-8000-000000000050@example.invalid>" { t.Fatal("recovery vector content mismatch") }
 digest,err:=auth.AccountActionDigest(envelope.Token)
 if err!=nil || hex.EncodeToString(digest[:])!="0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a" { t.Fatal("recovery vector action digest mismatch") }
 if cipher.KeyID()!="644c3b61a0e38691c386ea8e92837b1c13fc0582955ee75f774a12bbc22873ae" { t.Fatal("recovery vector key identity mismatch") }
 recipient:=cipher.RecipientKey(envelope.Recipient)
 if hex.EncodeToString(recipient[:])!="a0fdab14047e6825b6db8bd1c0414513f78eed4ae77b5346629b83a75e8041c1" { t.Fatal("recovery vector recipient identity mismatch") }
}
