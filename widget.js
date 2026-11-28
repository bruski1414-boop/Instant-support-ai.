(function(){
  "use strict";
  var script=document.currentScript;
  if(!script)return;
  var slug=script.getAttribute("data-veyra-slug");
  var api=(script.getAttribute("data-veyra-api")||new URL(script.src).origin).replace(/\/+$/,"");
  if(!slug){console.error("Veyra widget: missing data-veyra-slug");return;}
  var root=document.createElement("div");
  root.id="veyra-support-widget";
  document.body.appendChild(root);
  var shadow=root.attachShadow({mode:"open"});
  var style=document.createElement("style");
  style.textContent=":host{all:initial;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:#f5f8fc}*{box-sizing:border-box}.launcher{position:fixed;right:22px;bottom:22px;z-index:2147483000;border:0;border-radius:999px;padding:14px 19px;background:#d6e9fb;color:#081421;font-weight:750;box-shadow:0 8px 32px #0004;cursor:pointer}.panel{position:fixed;right:22px;bottom:82px;width:min(370px,calc(100vw - 28px));height:min(540px,calc(100vh - 115px));z-index:2147483000;background:#0d1724;border:1px solid #34485f;border-radius:18px;box-shadow:0 18px 60px #0008;display:none;overflow:hidden}.panel.open{display:flex;flex-direction:column}.head{padding:16px;background:#15263a;border-bottom:1px solid #30445b}.head strong{display:block;font-size:15px}.head small{color:#a9bed4}.messages{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px}.bubble{max-width:88%;padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}.assistant{align-self:flex-start;background:#1a2b3f;color:#f4f8fc}.guest{align-self:flex-end;background:#24516b;color:white}.status{padding:6px 14px;color:#f0d7a5;font-size:11px}.form{display:flex;gap:8px;padding:12px;border-top:1px solid #30445b}.form input{flex:1;min-width:0;background:#07101a;border:1px solid #3a4c62;border-radius:9px;padding:11px;color:white;font-size:13px}.form button{border:0;border-radius:9px;padding:0 13px;background:#c5def8;color:#081421;font-weight:750}.fine{padding:0 14px 10px;color:#91a4b9;font-size:10px}@media(max-width:480px){.launcher{right:14px;bottom:14px}.panel{right:14px;bottom:72px}}";
  shadow.appendChild(style);
  var panel=document.createElement("section");panel.className="panel";panel.setAttribute("aria-label","Veyra guest support");
  var head=document.createElement("div");head.className="head";
  var title=document.createElement("strong");title.textContent="Guest support";
  var sub=document.createElement("small");sub.textContent="Ask a question. A team member can help when needed.";
  head.append(title,sub);
  var messages=document.createElement("div");messages.className="messages";messages.setAttribute("aria-live","polite");
  var status=document.createElement("div");status.className="status";status.textContent="";
  var conversationId=null,conversationToken=null;
  var form=document.createElement("form");form.className="form";
  var input=document.createElement("input");input.type="text";input.maxLength=4000;input.placeholder="How can we help?";input.setAttribute("aria-label","Message the hotel");input.required=true;
  var send=document.createElement("button");send.type="submit";send.textContent="Send";
  form.append(input,send);
  var bookingToggle=document.createElement("button");bookingToggle.type="button";bookingToggle.textContent="Check room availability";bookingToggle.style.cssText="margin:0 14px 10px;padding:9px 12px;border:1px solid #526a82;border-radius:9px;background:#172b40;color:#eaf3fb;font-weight:650;cursor:pointer";
  var booking=document.createElement("section");booking.hidden=true;booking.style.cssText="padding:12px 14px;border-top:1px solid #30445b;max-height:230px;overflow:auto";
  var bookingTitle=document.createElement("strong");bookingTitle.textContent="Room availability and booking request";bookingTitle.style.cssText="display:block;font-size:13px;margin-bottom:8px";
  var dates=document.createElement("div");dates.style.cssText="display:grid;grid-template-columns:1fr 1fr;gap:7px";
  function field(labelText,type){var wrap=document.createElement("label");wrap.style.cssText="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#a9bed4";var label=document.createElement("span");label.textContent=labelText;var el=document.createElement("input");el.type=type;el.required=true;el.style.cssText="min-width:0;width:100%;padding:8px;border:1px solid #3a4c62;border-radius:7px;background:#07101a;color:white;font:12px inherit";wrap.append(label,el);return {wrap:wrap,input:el};}
  var checkIn=field("Check-in","date"),checkOut=field("Check-out","date"),guestCount=field("Guests","number");guestCount.input.min="1";guestCount.input.max="20";guestCount.input.value="2";
  dates.append(checkIn.wrap,checkOut.wrap,guestCount.wrap);
  var availabilityButton=document.createElement("button");availabilityButton.type="button";availabilityButton.textContent="Check availability";availabilityButton.style.cssText="margin:9px 0;padding:8px 11px;border:0;border-radius:8px;background:#c5def8;color:#081421;font-weight:700";
  var quoteSelect=document.createElement("select");quoteSelect.hidden=true;quoteSelect.style.cssText="display:block;width:100%;padding:8px;margin:0 0 8px;border:1px solid #3a4c62;border-radius:7px;background:#07101a;color:white";
  var guestName=field("Full name","text"),guestPhone=field("Phone","tel"),guestEmail=field("Email (optional)","email");guestName.input.maxLength=120;guestPhone.input.maxLength=40;guestEmail.input.maxLength=254;guestEmail.input.required=false;
  var guestFields=document.createElement("div");guestFields.style.cssText="display:grid;grid-template-columns:1fr 1fr;gap:7px";guestFields.append(guestName.wrap,guestPhone.wrap,guestEmail.wrap);
  var requestButton=document.createElement("button");requestButton.type="button";requestButton.textContent="Send booking request";requestButton.disabled=true;requestButton.style.cssText="margin:9px 0;padding:8px 11px;border:0;border-radius:8px;background:#c5def8;color:#081421;font-weight:700;opacity:.55";
  var bookingStatus=document.createElement("p");bookingStatus.setAttribute("aria-live","polite");bookingStatus.style.cssText="font-size:11px;line-height:1.45;color:#f0d7a5;margin:4px 0";
  var bookingFine=document.createElement("p");bookingFine.textContent="This sends a request to the hotel, not a confirmed reservation. Payment and final confirmation are not available in this widget. Your details are sent to the hotel booking service.";bookingFine.style.cssText="font-size:10px;line-height:1.4;color:#91a4b9;margin:6px 0";
  booking.append(bookingTitle,dates,availabilityButton,quoteSelect,guestFields,requestButton,bookingStatus,bookingFine);
  var selectedQuote=null,requestKey=null;
  function newRequestKey(){return window.crypto&&window.crypto.randomUUID?window.crypto.randomUUID().replace(/-/g,""):"veyra_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,18);}
  function setBookingStatus(text){bookingStatus.textContent=text;}
  function updateRequestButton(){var ok=!!selectedQuote&&guestName.input.value.trim().length>0&&guestPhone.input.value.trim().length>0;requestButton.disabled=!ok;requestButton.style.opacity=ok?"1":".55";}
  [guestName.input,guestPhone.input,guestEmail.input].forEach(function(el){el.addEventListener("input",updateRequestButton);});
  bookingToggle.addEventListener("click",function(){booking.hidden=!booking.hidden;});
  availabilityButton.addEventListener("click",async function(){
    selectedQuote=null;requestKey=null;quoteSelect.hidden=true;quoteSelect.replaceChildren();updateRequestButton();
    var start=checkIn.input.value,end=checkOut.input.value,count=Number(guestCount.input.value);
    if(!start||!end||end<=start||!Number.isInteger(count)||count<1||count>20){setBookingStatus("Enter valid dates and a guest count between 1 and 20.");return;}
    availabilityButton.disabled=true;setBookingStatus("Checking the hotel's live availability…");
    try{
      var url=api+"/api/public/"+encodeURIComponent(slug)+"/availability?"+new URLSearchParams({checkIn:start,checkOut:end,guestCount:String(count)}).toString();
      var response=await fetch(url,{method:"GET"});var data=await response.json();
      if(!response.ok||data.availabilityStatus!=="checked")throw new Error(data.error||"Availability could not be verified. Please contact hotel staff.");
      if(!Array.isArray(data.quotes)||!data.quotes.length)throw new Error("No bookable room quotes were returned. Please contact hotel staff.");
      data.quotes.forEach(function(q){var option=document.createElement("option");option.value=q.quoteId;var amount;try{amount=new Intl.NumberFormat(undefined,{style:"currency",currency:q.currency}).format(Number(q.amountMinor)/100);}catch(_){amount=q.currency+" "+(Number(q.amountMinor)/100).toFixed(2);}option.textContent=q.roomTypeName+" — "+amount+" total";quoteSelect.appendChild(option);});
      selectedQuote=data.quotes[0];quoteSelect.hidden=false;quoteSelect.addEventListener("change",function(){selectedQuote=data.quotes.find(function(q){return q.quoteId===quoteSelect.value;})||null;requestKey=null;updateRequestButton();});
      setBookingStatus("Availability checked. Select a room and enter your contact details to send a request. Quotes expire shortly.");
      updateRequestButton();
    }catch(err){setBookingStatus(err.message);}
    finally{availabilityButton.disabled=false;}
  });
  requestButton.addEventListener("click",async function(){
    if(!selectedQuote)return;requestKey=requestKey||newRequestKey();requestButton.disabled=true;setBookingStatus("Sending your request…");
    try{
      var response=await fetch(api+"/api/public/"+encodeURIComponent(slug)+"/booking-requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({quoteId:selectedQuote.quoteId,idempotencyKey:requestKey,guest:{name:guestName.input.value.trim(),phone:guestPhone.input.value.trim(),email:guestEmail.input.value.trim()||undefined}})});
      var data=await response.json();if(!response.ok)throw new Error(data.error||"The hotel could not accept this request. Please check availability again.");
      requestKey=null;
      setBookingStatus("Request saved. Reference: "+data.bookingId+". This is not a confirmed reservation; the hotel must arrange payment and confirm the booking.");
      add("Your booking request has been sent to the hotel. It is not confirmed yet; the hotel team must arrange payment and send final confirmation.","assistant");
      selectedQuote=null;quoteSelect.hidden=true;updateRequestButton();
    }catch(err){setBookingStatus(err.message);updateRequestButton();}
  });
  var fine=document.createElement("div");fine.className="fine";fine.textContent="Please do not send payment details, passport numbers or sensitive personal information.";
  panel.append(head,bookingToggle,booking,messages,status,form,fine);
  var launcher=document.createElement("button");launcher.className="launcher";launcher.type="button";launcher.textContent="Chat with us";
  shadow.append(panel,launcher);
  function add(text,kind){var b=document.createElement("div");b.className="bubble "+kind;b.textContent=text;messages.appendChild(b);messages.scrollTop=messages.scrollHeight;}
  add("Hello. How can we help with your stay?", "assistant");
  launcher.addEventListener("click",function(){panel.classList.toggle("open");if(panel.classList.contains("open"))input.focus();});
  form.addEventListener("submit",async function(e){
    e.preventDefault();var message=input.value.trim();if(!message)return;
    add(message,"guest");input.value="";send.disabled=true;status.textContent="Preparing a response…";
    try{
      var response=await fetch(api+"/api/public/"+encodeURIComponent(slug)+"/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:message,conversationId:conversationId,conversationToken:conversationToken})});
      var data=await response.json();
      if(!response.ok)throw new Error(data.error||"The assistant is temporarily unavailable.");
      conversationId=data.conversationId||conversationId;conversationToken=data.conversationToken||conversationToken;
      add(data.reply||"Please contact the hotel team.","assistant");
      if(data.needsHuman){
        status.textContent=data.notificationDelivered?"The hotel notification endpoint accepted the handoff.":"Please contact hotel staff directly; automatic notification is not confirmed.";
      }else{status.textContent="";}
    }catch(err){add(err.message+" Please use the hotel's usual contact route if you need help now.","assistant");status.textContent="";}
    finally{send.disabled=false;input.focus();}
  });
})();