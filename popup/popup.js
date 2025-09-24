const toggleBtn = document.getElementById("toggleForm");
const form = document.getElementById("formArea");
const saveBtn = document.getElementById("saveBtn");
const select = document.getElementById("selectMessage");
const preview = document.getElementById("messagePreview");
const sendBtn = document.getElementById("sendBtn");

let messages = {};

form.style.display = "none";

// Alterna visibilidade do formulário
toggleBtn.onclick = () => {
    form.style.display = form.style.display === "none" ? "flex" : "none";
};

select.onchange = () => {
    const selected = select.value;
    // Verifique se há uma mensagem selecionada antes de atualizar a visualização
    preview.textContent = selected && messages[selected] ? messages[selected] : "";
};  

// Carrega mensagens ao iniciar
chrome.storage.local.get("messages", (data) => {
  messages = data.messages || {};
  updateSelect();
});

// Atualiza dropdown
function updateSelect() {
  select.innerHTML = `<option disabled selected>Selecione uma mensagem</option>`;
  Object.keys(messages).forEach((title) => {
    const option = document.createElement("option");
    option.value = title;
    option.textContent = title;
    select.appendChild(option);
  });
}

// Salva nova mensagem
saveBtn.onclick = () => {
    const title = document.getElementById("titleInput").value.trim();
    const content = document.getElementById("msgInput").value.trim();    

  if (!title || !content) return alert("Preencha todos os campos!");

  messages[title] = content;
  chrome.storage.local.set({ messages }, () => {
    updateSelect();
    form.style.display = "none";
    document.getElementById("new-title").value = "";
    document.getElementById("new-content").value = "";
  });
};

select.onchange = () => {
    const selected = select.value;
  
    // Se uma mensagem for selecionada, atualiza a pré-visualização e torna-a visível
    if (selected && messages[selected]) {
      preview.textContent = messages[selected];
      preview.style.display = "block"; // Torna a pré-visualização visível
    } else {
      preview.textContent = ""; // Limpa o conteúdo
      preview.style.display = "none"; // Oculta a pré-visualização
    }
  };
  

// Envia mensagem para content script
sendBtn.onclick = () => {
    const selected = select.value;
    if (!selected || !messages[selected]) return alert("Selecione uma mensagem!");
    sendMessage(messages[selected]);
};  

function sendMessage(message) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: (msg) => {
          const inputBox = document.querySelectorAll("div[contenteditable='true']")[1];
          if (inputBox) {
            inputBox.focus();
            const dataTransfer = new DataTransfer();
            dataTransfer.setData("text", msg);
            inputBox.dispatchEvent(new ClipboardEvent("paste", {
              clipboardData: dataTransfer,
              bubbles: true
            }));
          } else {
            console.error("Caixa de entrada do WhatsApp não encontrada.");
          }
        },
        args: [message]
      });
    });
}