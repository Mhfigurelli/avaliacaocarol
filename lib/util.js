// Primeiro nome, para o cumprimento das mensagens.
// Ex.: "Eleci Amoedo Gonçalves" -> "Eleci"; "Sergio Luis Alves Campos- Ipê" -> "Sergio".
// A fila continua guardando/mostrando o nome completo (identificação).
export function firstName(full) {
  const f = String(full || "").trim();
  return f.split(/\s+/)[0] || f;
}
