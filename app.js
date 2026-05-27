// Render에 배포한 본인의 API 주소로 연동
const BACKEND_API_URL = 'https://sasadomi-api.onrender.com';

let currentStudentId = '';

// [기능] 계정 연동 및 데이터 패치
async function syncAccount() {
    const studentId = document.getElementById('studentId').value;
    const studentPw = document.getElementById('studentPw').value;
    const grade = document.getElementById('grade').value;
    const sclass = document.getElementById('sclass').value;
    const number = document.getElementById('number').value;

    if (!studentId || !studentPw) return alert('아이디와 패스워드를 적어주세요.');

    try {
        const res = await fetch(`${BACKEND_API_URL}/api/login-and-fetch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId, studentPw, grade, sclass, number })
        });

        const data = await res.json();
        
        if (data.success) {
            currentStudentId = studentId;
            document.getElementById('rewardView').innerText = data.totalReward;
            document.getElementById('penaltyView').innerText = data.totalPenalty;

            // 💡 수정됨: 상점 리스트와 벌점 리스트를 하나의 배열로 합치기
            const combinedList = [...(data.rewardList || []), ...(data.penaltyList || [])];

            // 테이블 리스트 렌더링
            const tbody = document.querySelector('#historyTable tbody');
            tbody.innerHTML = '';
            
            combinedList.forEach(item => {
                tbody.innerHTML += `<tr>
                    <td>${item.score}</td>
                    <td>${item.weight}</td>
                    <td>${item.reason}</td>
                    <td>${item.date}</td>
                </tr>`;
            });

            document.getElementById('dashboard').style.display = 'block';
            alert('성공적으로 계정이 연동 및 최신 데이터 동기화 완료되었습니다.');
        } else {
            alert(data.message || '인증 실패');
        }
    } catch (error) {
        console.error(error);
        alert('서버 통신 중 오류가 발생했습니다.');
    }
}

// [기능] 자율학습 장소 변경 이벤트 핸들러 (본관 전용 조건부 필드 제어)
function toggleStudyFields(placeValue) {
    const conditionalBox = document.getElementById('conditionalStudyFields');
    if (placeValue === '3') { // 본관 선택 코드값 '3'
        conditionalBox.style.display = 'block';
    } else {
        conditionalBox.style.display = 'none';
    }
}

// [기능] 자율학습 신청 제출
async function submitStudy() {
    const rawDate = document.getElementById('studyDate').value;
    const time = document.getElementById('studyTime').value;
    const place = document.getElementById('studyPlace').value;
    
    if (!rawDate) return alert('날짜를 지정해 주세요.');
    
    // 학교 기준 타임스탬프 계산 (KST 기준 해당 일의 00시 00분 00초 타임스탬프 반환)
    const dateObj = new Date(rawDate + 'T00:00:00');
    const timestampSeconds = Math.floor(dateObj.getTime() / 1000);

    const payload = {
        studentId: currentStudentId,
        date: timestampSeconds,
        time: time,
        place: place
    };

    // 본관 전용 세부 항목 추가 조건문
    if (place === '3') {
        payload.detail = document.getElementById('studyDetail').value;
        payload.detail_reason = document.getElementById('studyDetailReason').value;
        if (!payload.detail_reason) return alert('본관 사유를 기록해 주세요.');
    }

    try {
        const res = await fetch(`${BACKEND_API_URL}/api/apply-study`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.success) {
            alert('자율학습 신청 대행 요청이 처리되었습니다!');
            closeModal('studyModal');
        } else {
            alert(data.message || '신청 실패');
        }
    } catch (error) {
        console.error(error);
        alert('서버 통신 중 오류가 발생했습니다.');
    }
}

// [기능] 외출 외박 신청 제출
async function submitOut() {
    const outType = document.getElementById('outType').value;
    const outReason = document.getElementById('outReason').value;
    const bDateInput = document.getElementById('outBdate').value;
    const bTimeInput = document.getElementById('outBtime').value;
    const eDateInput = document.getElementById('outEdate').value;
    const eTimeInput = document.getElementById('outEtime').value;

    if (!bDateInput || !eDateInput || !outReason) return alert('필수 항목을 빠짐없이 기입해 주세요.');

    // 유닉스 타임스탬프 역산 계산식 적용 (초 단위)
    const bdateSec = Math.floor(new Date(`${bDateInput}T${bTimeInput}:00`).getTime() / 1000);
    const edateSec = Math.floor(new Date(`${eDateInput}T${eTimeInput}:00`).getTime() / 1000);

    try {
        const res = await fetch(`${BACKEND_API_URL}/api/apply-out`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                studentId: currentStudentId,
                type: outType,
                reason: outReason,
                bdate: bdateSec,
                edate: edateSec
            })
        });

        const data = await res.json();
        if (data.success) {
            alert('외출/외박 신청 연동 처리가 수락되었습니다.');
            closeModal('outModal');
        } else {
            alert(data.message || '신청 실패');
        }
    } catch (error) {
        console.error(error);
        alert('서버 통신 중 오류가 발생했습니다.');
    }
}

// 📌 [기능] 계정 연동 해제
async function disconnectAccount() {
    if (!currentStudentId) return alert('현재 연동된 계정이 없습니다.');
    
    // 실수로 누르는 것을 방지하기 위한 확인 창
    if (!confirm('정말 계정 연동을 해제하시겠습니까?\n저장된 비밀번호와 자동 로그인 정보가 즉시 삭제됩니다.')) return;

    try {
        const res = await fetch(`${BACKEND_API_URL}/api/disconnect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: currentStudentId })
        });

        const data = await res.json();
        
        if (data.success) {
            alert('계정 연동이 안전하게 해제되었습니다.');
            
            // 데이터 초기화 및 대시보드 숨기기
            currentStudentId = '';
            document.getElementById('dashboard').style.display = 'none';
            document.getElementById('studentId').value = '';
            document.getElementById('studentPw').value = '';
        } else {
            alert(data.message || '연동 해제 실패');
        }
    } catch (error) {
        console.error(error);
        alert('서버 통신 중 오류가 발생했습니다.');
    }
}

// 모달 제어 유틸리티
function openModal(id) { document.getElementById(id).style.display = 'block'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
